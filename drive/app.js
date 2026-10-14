// Bookshelf — Drive upload page: sign in with Google in the browser, add
// PDFs/EPUBs to the Bookshelf folder (with cover and details made here), pick
// books already in Drive, rename or remove books. Same Google project as the
// TV, so the TV sees everything added here.
// Testing without Google (only when served from this Mac, never on the
// public page — a crafted link must not redirect uploads elsewhere):
//   ?mock=<mock server>   fake sign-in and Drive (tests/mock-google.js)
//   ?api=<mock server>    real sign-in flow, fake Drive (Google's script stubbed)
(function () {
    'use strict';
    var App = window.App;
    var cfg = window.DRIVE_UPLOAD_CONFIG || {};
    var local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
    var params = new URLSearchParams(location.search);
    var mock = local && params.get('mock');
    var API = mock || (local && params.get('api')) || 'https://www.googleapis.com';
    var SCOPES = 'https://www.googleapis.com/auth/drive.file';
    var $ = function (id) { return document.getElementById(id); };
    App.BookMeta.pdfjsBase = '../tv/vendor/pdfjs/';

    var token = null, tokenClient = null, drive = null, folders = null, account = null, books = [], progress = {};

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function size(n) { return n >= 1048576 ? (n / 1048576).toFixed(n >= 104857600 ? 0 : 1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('Could not load ' + src)); };
            document.head.appendChild(s);
        });
    }

    /* ---- Sign-in (Google Identity Services) -----------------------------------
       The access token lasts an hour. It's kept in this tab's sessionStorage, so
       reloading the page doesn't need a new Google sign-in (closing the tab
       forgets it). */

    var TOKEN_KEY = 'bookshelf.token';
    function keepToken(t) {
        token = t;
        try { if (t) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(t)); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ }
    }
    function savedToken() {
        try {
            var t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
            return t && t.exp > Date.now() + 60000 ? t : null;
        } catch (e) { return null; }
    }

    function requestToken(prompt) {
        return new Promise(function (resolve, reject) {
            tokenClient.callback = function (resp) {
                if (resp.error) return reject(new Error(resp.error_description || resp.error));
                keepToken({ value: resp.access_token, exp: Date.now() + resp.expires_in * 1000 });
                resolve(token.value);
            };
            tokenClient.error_callback = function (e) { reject(new Error(e && e.type === 'popup_closed' ? 'Sign-in window closed.' : 'Sign-in failed.')); };
            tokenClient.requestAccessToken({ prompt: prompt });
        });
    }

    function getToken() {
        if (token && token.exp > Date.now() + 60000) return Promise.resolve(token.value);
        if (mock) {
            return fetch(mock + '/test/token', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (j) {
                token = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
                return token.value;
            });
        }
        // A restored session has no sign-in client yet, and Google's window
        // may only open from a click — so after the hour, sign in again.
        if (!tokenClient) { signOut(); return Promise.reject(new Error('Your sign-in ended after an hour. Sign in again.')); }
        return requestToken(''); // after the first consent this is quick
    }

    async function signIn(restored) {
        var button = $('signIn');
        $('setup').hidden = true;
        button.disabled = true;
        button.textContent = 'Signing In…';
        if (mock || restored) { $('signedOut').hidden = true; $('loading').hidden = false; }
        try {
            if (!mock && !restored) {
                if (!cfg.webClientId) throw new Error('Google sign-in isn’t set up yet: add drive.config.json on the Mac and restart the server.');
                if (!window.google || !google.accounts) await loadScript('https://accounts.google.com/gsi/client');
                tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({ client_id: cfg.webClientId, scope: SCOPES, callback: function () {} });
                await requestToken('');
            }
            drive = App.DriveApi(API, getToken, function () { token = null; });
            account = (await drive.about()).user;
            folders = await drive.folders();
            $('avatar').textContent = (account.displayName || account.emailAddress || '?').trim().charAt(0).toUpperCase();
            $('avatar').title = account.emailAddress || account.displayName || '';
            $('fromDrive').hidden = !!mock || !cfg.apiKey;
            await load();
            $('signedOut').hidden = true;
            $('signedIn').hidden = false;
        } catch (e) {
            keepToken(null);
            $('signedIn').hidden = true;
            $('signedOut').hidden = false;
            $('setup').textContent = e.message + (mock || restored ? '' :
                ' If Google said “origin_mismatch”: after a settings change it can take up to a few hours until every Google server knows this page. Try again a bit later.');
            $('setup').hidden = false;
        } finally {
            $('loading').hidden = true;
            button.disabled = false;
            button.textContent = 'Sign in with Google';
        }
    }

    function signOut() {
        keepToken(null);
        drive = null;
        books = [];
        closeMenu(true);
        $('signedIn').hidden = true;
        $('signedOut').hidden = false;
        $('navbar').classList.remove('on');
        $('count').textContent = '';
    }

    /* ---- Library -------------------------------------------------------------- */

    async function load() {
        var files = await drive.list(App.DriveApi.BOOKS, App.DriveApi.BOOK_FIELDS);
        books = files.map(function (f) { var b = App.DriveApi.toBook(f); if (b) { b.name = f.name; } return b; }).filter(Boolean);
        try {
            var p = await drive.list("name='progress.json' and '" + folders.root + "' in parents and trashed=false", 'id');
            progress = p.length ? await (await drive.media(p[0].id)).json() : {};
        } catch (e) { progress = {}; }
        render();
    }

    // Reading progress in percent, or null for a book not opened yet.
    function percent(b) { var p = progress[b.id]; return p ? Math.min(100, Math.max(1, Math.round(p.pct * 100))) : null; }

    var DOTS = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
    var shown = false; // the shelf fades in once, not on every reload

    function render() {
        $('count').textContent = books.length ? books.length + (books.length === 1 ? ' book' : ' books') : '';
        $('empty').hidden = books.length > 0;
        $('books').classList.toggle('intro', !shown);
        $('books').innerHTML = books.map(function (b, n) {
            var pct = percent(b);
            var state = pct === null ? '<span class="state new">New</span>' : pct >= 100 ? '<span class="state done">Finished</span>' : '<span class="state">' + pct + '%</span>';
            var hue = 0;
            for (var i = 0; i < b.title.length; i++) hue = (hue * 31 + b.title.charCodeAt(i)) >>> 0;
            return '<li class="book" data-id="' + esc(b.id) + '" style="--i:' + Math.min(n, 12) + '">' +
                '<button class="cover" type="button" data-act="menu" aria-label="' + esc(b.title) + '">' +
                '<span class="gen" style="--h:' + hue % 360 + '"><b>' + esc(b.title) + '</b><i></i><small>' + esc(b.author) + '</small></span></button>' +
                '<div class="title">' + esc(b.title) + '</div>' +
                '<div class="author">' + esc(b.author || b.format.toUpperCase()) + '</div>' +
                '<div class="status">' + state + '<button class="more" type="button" data-act="menu" aria-label="More">' + DOTS + '</button></div></li>';
        }).join('');
        if (books.length) shown = true;
        // Covers need the sign-in header, so they're fetched rather than linked.
        books.forEach(function (b) {
            if (!b.coverId) return;
            drive.media(b.coverId).then(function (r) { return r.blob(); }).then(function (blob) {
                var box = document.querySelector('.book[data-id="' + b.id + '"] .cover');
                if (box) box.firstChild.outerHTML = '<img alt="" src="' + URL.createObjectURL(blob) + '">';
            }).catch(function () {});
        });
    }

    /* ---- Adding books ------------------------------------------------------------ */

    // appProperties: key + value ≤ 124 bytes.
    function fit(key, value) {
        var v = String(value || '');
        var bytes = function (s) { return new TextEncoder().encode(key + s).length; };
        if (bytes(v) <= 124) return v;
        while (v && bytes(v + '…') > 124) v = v.slice(0, -1);
        return v + '…';
    }

    function details(meta, coverId) {
        var props = { bookshelf: '1', format: meta.format, title: fit('title', meta.title) };
        if (meta.author) props.author = fit('author', meta.author);
        if (coverId) props.cover = coverId;
        return props;
    }

    async function uploadCover(meta) {
        if (!meta.cover) return '';
        return (await drive.create({ name: meta.title.slice(0, 80) + '.jpg', parents: [folders.covers] }, meta.cover, 'image/jpeg')).id;
    }

    // Books are usually over the 5 MB limit of a one-request upload, so they
    // use Drive's resumable upload: open a session, then send the file.
    async function uploadBook(file, meta, props, onProgress) {
        var t = await getToken();
        var type = meta.format === 'pdf' ? 'application/pdf' : 'application/epub+zip';
        var start = await fetch(API + '/upload/drive/v3/files?uploadType=resumable&fields=id', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': type, 'X-Upload-Content-Length': String(file.size) },
            body: JSON.stringify({ name: file.name, mimeType: type, parents: [folders.root], appProperties: props })
        });
        var session = start.ok && start.headers.get('Location');
        if (!session) throw new Error('Google Drive answered ' + start.status);
        return new Promise(function (resolve, reject) {
            var x = new XMLHttpRequest();
            x.open('PUT', session);
            x.setRequestHeader('Content-Type', type);
            x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
            x.onload = function () { if (x.status < 300) resolve(); else reject(new Error('Google Drive answered ' + x.status)); };
            x.onerror = function () { reject(new Error('Connection lost')); };
            x.send(file);
        });
    }

    function queueRow(name) {
        var ext = ((/\.(pdf|epub)$/i.exec(name) || [])[1] || '').toLowerCase();
        var li = document.createElement('li');
        li.innerHTML = '<span class="kind ' + ext + '">' + ext.toUpperCase() + '</span><span class="name">' + esc(name) + '</span>' +
            '<span class="state">Waiting…</span><div class="bar"><i></i></div>';
        $('queue').appendChild(li);
        return {
            state: function (text, kind) { var s = li.querySelector('.state'); s.textContent = text; s.className = 'state' + (kind ? ' ' + kind : ''); li.className = kind || ''; },
            bar: function (f) { li.querySelector('.bar i').style.width = (f * 100).toFixed(1) + '%'; },
            done: function () {
                setTimeout(function () { li.classList.add('gone'); setTimeout(function () { li.remove(); }, 300); }, 4000);
            }
        };
    }

    async function add(file) {
        var row = queueRow(file.name);
        try {
            if (books.some(function (b) { return b.name === file.name && b.size === file.size; })) {
                row.state('Already in Bookshelf', 'ok');
                return row.done();
            }
            row.state('Reading…');
            var meta = await App.BookMeta.read(file, file.name);
            row.state('Uploading cover…');
            var props = details(meta, await uploadCover(meta));
            await uploadBook(file, meta, props, function (f) { row.bar(f); row.state(f < 1 ? Math.round(f * 100) + '%' : 'Finishing…'); });
            row.bar(1);
            row.state('Added', 'ok');
            row.done();
        } catch (e) {
            row.state(e.message || 'Failed', 'bad');
        }
    }

    async function addAll(files) {
        for (var i = 0; i < files.length; i++) await add(files[i]);
        await load();
    }

    // A book picked from elsewhere in Drive stays where it is; it only gets
    // the Bookshelf mark, details and a cover.
    async function adopt(doc) {
        var row = queueRow(doc.name);
        try {
            row.state('Reading…');
            var blob = await (await drive.media(doc.id)).blob();
            var meta = await App.BookMeta.read(blob, doc.name);
            row.state('Adding…');
            await drive.update(doc.id, { appProperties: details(meta, await uploadCover(meta)) });
            row.bar(1);
            row.state('Added', 'ok');
            row.done();
        } catch (e) {
            row.state(e.message || 'Failed', 'bad');
        }
    }

    async function pickFromDrive() {
        try {
            if (!window.gapi) await loadScript('https://apis.google.com/js/api.js');
            await new Promise(function (resolve) { gapi.load('picker', resolve); });
            var t = await getToken();
            var view = new google.picker.DocsView(google.picker.ViewId.DOCS).setMimeTypes('application/pdf,application/epub+zip').setIncludeFolders(true);
            new google.picker.PickerBuilder()
                .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
                .setAppId(cfg.projectNumber).setOAuthToken(t).setDeveloperKey(cfg.apiKey)
                .addView(view)
                .setCallback(async function (data) {
                    if (data.action !== google.picker.Action.PICKED) return;
                    for (var i = 0; i < data.docs.length; i++) await adopt(data.docs[i]);
                    await load();
                })
                .build().setVisible(true);
        } catch (e) {
            queueRow('Pick from Google Drive').state(e.message || 'Couldn’t open the picker', 'bad');
        }
    }

    /* ---- Menus, the edit form and the remove alert --------------------------------------
       As in iOS 26 and macOS 26, a menu opens from the button that was pressed (or
       at the pointer, for a right-click on a Mac). On a Mac the remove question is
       an alert; on a phone it opens from the same button. */

    var mac = window.matchMedia('(hover: hover) and (pointer: fine)');
    var menu = $('menu'), menuFrom = null, menuItems = [], menuTimer = 0, chosen = false, swallow = false;
    var editor = $('editor'), alertBox = $('alert'), editing = null, alertRun = null;
    var ICONS = {
        edit: '<path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16zM13.5 6.5l4 4"/>',
        trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7M10 11v6M14 11v6"/>',
        out: '<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14M10 8l-4 4 4 4M6 12h10"/>'
    };

    // items: { label, icon, danger, run } or '-' for a line between groups.
    function openMenu(from, head, items, at) {
        closeMenu(true);
        if (!at && !(from && from.isConnected)) at = { x: innerWidth / 2 - 120, y: innerHeight / 3 };
        menuFrom = from;
        menuItems = items;
        chosen = false;
        menu.innerHTML = (head ? '<div class="m-head">' + head + '</div>' : '') + items.map(function (it, i) {
            return it === '-' ? '<div class="m-sep" role="separator"></div>' :
                '<button class="m-item' + (it.danger ? ' danger' : '') + '" type="button" role="menuitem" data-i="' + i + '">' +
                (it.icon ? '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICONS[it.icon] + '</svg>' : '') + '<span>' + esc(it.label) + '</span></button>';
        }).join('');
        menu.className = 'menu';
        menu.style.left = menu.style.top = '0px'; // measured at full width
        menu.hidden = false;
        if (from) from.setAttribute('aria-expanded', 'true');
        var w = menu.offsetWidth, h = menu.offsetHeight, vw = document.documentElement.clientWidth, vh = innerHeight;
        var m = 8, gap = mac.matches ? 4 : 8, x, y, o;
        if (at) {
            x = at.x + w > vw - m ? at.x - w : at.x;
            y = at.y + h > vh - m ? at.y - h : at.y;
            o = at;
        } else {
            var r = from.getBoundingClientRect();
            x = r.left + r.width / 2 > vw / 2 ? r.right - w : r.left; // opens toward the middle
            y = r.bottom + gap;
            if (y + h > vh - m && r.top - gap - h > m) y = r.top - gap - h;
            o = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        x = Math.max(m, Math.min(x, vw - w - m));
        y = Math.max(m, Math.min(y, vh - h - m));
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
        menu.style.transformOrigin = (o.x - x) + 'px ' + (o.y - y) + 'px'; // grows out of the button
        menu.focus({ preventScroll: true });
    }

    function closeMenu(now) {
        clearTimeout(menuTimer);
        if (menu.hidden) return;
        if (menuFrom) {
            menuFrom.removeAttribute('aria-expanded');
            if (menu.contains(document.activeElement) && menuFrom.isConnected) menuFrom.focus({ preventScroll: true });
        }
        menuFrom = null;
        if (now) { menu.hidden = true; return; }
        menu.classList.add('out');
        menuTimer = setTimeout(function () { menu.hidden = true; }, 200);
    }

    menu.addEventListener('click', function (e) {
        var b = e.target.closest('.m-item');
        if (!b || chosen) return;
        chosen = true;
        var it = menuItems[b.getAttribute('data-i')];
        if (!mac.matches) { closeMenu(); return it.run(); }
        // The chosen item blinks once, then the menu fades, as on a Mac.
        b.focus({ preventScroll: true });
        b.classList.add('blink');
        setTimeout(function () { b.classList.remove('blink'); }, 70);
        setTimeout(function () { closeMenu(); it.run(); }, 140);
    });
    // On a Mac the highlight follows the pointer, and the arrow keys move it.
    menu.addEventListener('mousemove', function (e) {
        var b = e.target.closest('.m-item');
        if (mac.matches && b && b !== document.activeElement && !chosen) b.focus({ preventScroll: true });
    });
    menu.addEventListener('mouseleave', function () { if (mac.matches && !chosen) menu.focus({ preventScroll: true }); });
    menu.addEventListener('keydown', function (e) {
        var items = [].slice.call(menu.querySelectorAll('.m-item')), i = items.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            items[e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length : i) - 1].focus();
        } else if (e.key === 'Tab') {
            e.preventDefault();
        }
    });
    // A tap or click outside only closes the menu; it doesn't press what's under it.
    document.addEventListener('pointerdown', function (e) {
        swallow = false;
        if (menu.hidden || menu.classList.contains('out') || menu.contains(e.target)) return;
        closeMenu();
        swallow = true;
    }, true);
    document.addEventListener('click', function (e) {
        if (!swallow) return;
        swallow = false;
        e.preventDefault();
        e.stopPropagation();
    }, true);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !menu.hidden) closeMenu(); });
    window.addEventListener('scroll', function () { closeMenu(); }, { passive: true });
    window.addEventListener('resize', function () { closeMenu(true); });

    function openDialog(d) {
        closeMenu(true);
        clearTimeout(d.closer);
        d.classList.remove('closing');
        if (!d.open) d.showModal();
    }
    // Plays the closing animation first.
    function closeDialog(d) {
        if (!d.open || d.classList.contains('closing')) return;
        d.classList.add('closing');
        d.closer = setTimeout(function () { d.classList.remove('closing'); d.close(); }, 200);
    }
    [editor, alertBox].forEach(function (d) {
        d.addEventListener('cancel', function (e) { e.preventDefault(); closeDialog(d); }); // Esc, with the animation
        d.addEventListener('click', function (e) {
            var r = d.getBoundingClientRect();
            var outside = e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
            // A phone sheet closes with a tap above it; Mac sheets and alerts wait for a button.
            if (e.target.closest('[data-close]') || (e.target === d && outside && !mac.matches)) closeDialog(d);
        });
    });

    function bookFor(el) {
        var id = el.closest('.book').getAttribute('data-id');
        return books.filter(function (b) { return b.id === id; })[0];
    }

    function bookMenu(book, from, at) {
        var pct = percent(book);
        var info = [book.author, book.format.toUpperCase(), book.size && size(book.size), pct === null ? '' : pct >= 100 ? 'Finished' : pct + '% read'];
        openMenu(from, '<strong>' + esc(book.title) + '</strong><span>' + esc(info.filter(Boolean).join(' · ')) + '</span>', [
            { label: 'Edit Title and Author', icon: 'edit', run: function () { editBook(book); } },
            '-',
            { label: 'Remove from Bookshelf', icon: 'trash', danger: true, run: function () { confirmRemove(book, from, at); } }
        ], at);
    }

    function confirmRemove(book, from, at) {
        var uploaded = book.parents.indexOf(folders.root) !== -1;
        var title = 'Remove “' + book.title + '”?';
        var text = uploaded ? 'It moves to the Google Drive trash. You can restore it from there for 30 days.' : 'It stays in your Google Drive and just leaves Bookshelf.';
        var run = function () { change(book, remove(book, uploaded), 'Couldn’t remove it'); };
        if (mac.matches) {
            $('alertTitle').textContent = title;
            $('alertText').textContent = text;
            alertRun = run;
            openDialog(alertBox);
        } else {
            openMenu(from, '<strong>' + esc(title) + '</strong><span>' + esc(text) + '</span>', [{ label: 'Remove Book', icon: 'trash', danger: true, run: run }], at);
        }
    }
    $('alertOk').addEventListener('click', function () { closeDialog(alertBox); alertRun(); });

    // Same rule as the TV: uploaded → Drive trash; picked → just unmarked.
    async function remove(book, uploaded) {
        if (uploaded) await drive.update(book.id, { trashed: true });
        else await drive.update(book.id, { appProperties: { bookshelf: null, cover: null } });
        if (book.coverId) drive.update(book.coverId, { trashed: true }).catch(function () {});
    }

    // Dims the book while Drive is updated, then reloads the shelf.
    async function change(book, work, failed) {
        var li = document.querySelector('.book[data-id="' + book.id + '"]');
        if (li) li.classList.add('busy');
        try { await work; } catch (e) { queueRow(book.name || book.title).state(e.message || failed, 'bad'); }
        await load();
    }

    function field(name) { return $('editForm').querySelector('[name=' + name + ']'); }

    function editBook(book) {
        editing = book;
        field('title').value = book.title;
        field('author').value = book.author || '';
        openDialog(editor);
        field('title').focus();
        if (mac.matches) field('title').select();
    }

    $('editForm').addEventListener('submit', function (e) {
        e.preventDefault();
        var title = field('title').value.trim() || editing.title;
        var author = field('author').value.trim();
        closeDialog(editor);
        change(editing, drive.update(editing.id, { appProperties: { title: fit('title', title), author: author ? fit('author', author) : null } }), 'Couldn’t save it');
    });

    $('books').addEventListener('click', function (e) {
        var btn = e.target.closest('[data-act=menu]');
        var book = btn && bookFor(btn);
        if (!book) return;
        // A click on the cover opens the menu at the pointer on a Mac, from "…" on a phone.
        var at = mac.matches && btn.classList.contains('cover') ? { x: e.clientX, y: e.clientY } : null;
        bookMenu(book, btn.closest('.book').querySelector('.more'), at);
    });
    $('books').addEventListener('contextmenu', function (e) {
        var el = e.target.closest('.book');
        var book = el && mac.matches && bookFor(el);
        if (!book) return;
        e.preventDefault();
        bookMenu(book, el.querySelector('.more'), { x: e.clientX, y: e.clientY });
    });

    /* ---- Wiring --------------------------------------------------------------------- */

    $('signIn').addEventListener('click', function () { signIn(false); }); // not signIn(event): that reads as "restored"
    $('avatar').addEventListener('click', function () {
        var name = account.displayName || account.emailAddress || '';
        openMenu(this, '<strong>' + esc(name) + '</strong>' + (account.emailAddress && account.emailAddress !== name ? '<span>' + esc(account.emailAddress) + '</span>' : ''),
            [{ label: 'Sign Out', icon: 'out', run: signOut }]);
    });
    $('fromDrive').addEventListener('click', pickFromDrive);
    $('pick').addEventListener('change', function (e) { addAll(Array.prototype.slice.call(e.target.files)); e.target.value = ''; });

    // Files can be dropped anywhere on the page.
    var depth = 0;
    function withFiles(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1; }
    document.addEventListener('dragenter', function (e) {
        if (!withFiles(e)) return;
        e.preventDefault();
        if (++depth === 1 && !$('signedIn').hidden) $('dropzone').hidden = false;
    });
    document.addEventListener('dragover', function (e) { if (withFiles(e)) e.preventDefault(); });
    document.addEventListener('dragleave', function (e) { if (withFiles(e) && --depth <= 0) { depth = 0; $('dropzone').hidden = true; } });
    document.addEventListener('drop', function (e) {
        if (!withFiles(e)) return;
        e.preventDefault(); // never open the file in place of the page
        depth = 0;
        $('dropzone').hidden = true;
        if (!$('signedIn').hidden && e.dataTransfer.files.length) addAll(Array.prototype.slice.call(e.dataTransfer.files));
    });

    // The large title moves into the top bar once it scrolls away, as in iOS.
    if (window.IntersectionObserver) {
        new IntersectionObserver(function (entries) {
            $('navbar').classList.toggle('on', !entries[0].isIntersecting && !$('signedIn').hidden);
        }, { rootMargin: '-44px 0px 0px 0px' }).observe($('title'));
    }

    if (mock) signIn(); // tests: no sign-in window
    else if ((token = savedToken())) signIn(true); // reloaded within the hour: still signed in
})();
