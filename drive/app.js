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

    var token = null, tokenClient = null, drive = null, folders = null, books = [], progress = {};

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
        $('setup').hidden = true;
        try {
            if (!mock && !restored) {
                if (!cfg.webClientId) throw new Error('Google sign-in isn’t set up yet: add drive.config.json on the Mac and restart the server.');
                if (!window.google || !google.accounts) await loadScript('https://accounts.google.com/gsi/client');
                tokenClient = tokenClient || google.accounts.oauth2.initTokenClient({ client_id: cfg.webClientId, scope: SCOPES, callback: function () {} });
                await requestToken('');
            }
            drive = App.DriveApi(API, getToken, function () { token = null; });
            var me = (await drive.about()).user;
            folders = await drive.folders();
            $('who').textContent = me.emailAddress || me.displayName;
            $('signedOut').hidden = true;
            $('signedIn').hidden = false;
            $('fromDrive').hidden = !!mock || !cfg.apiKey;
            await load();
        } catch (e) {
            keepToken(null);
            $('signedIn').hidden = true;
            $('signedOut').hidden = false;
            $('setup').textContent = e.message + (mock || restored ? '' :
                ' If Google said “origin_mismatch”: after a settings change it can take up to a few hours until every Google server knows this page. Try again a bit later.');
            $('setup').hidden = false;
        }
    }

    function signOut() {
        keepToken(null);
        drive = null;
        books = [];
        $('signedIn').hidden = true;
        $('signedOut').hidden = false;
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

    function render() {
        $('count').textContent = books.length ? books.length + (books.length === 1 ? ' book' : ' books') : '';
        $('empty').hidden = books.length > 0;
        $('books').innerHTML = books.map(function (b) {
            var p = progress[b.id], pct = p ? Math.round(p.pct * 100) : 0;
            var state = p ? (pct >= 100 ? 'Finished' : pct + '% read') : 'Not started';
            var hue = 0;
            for (var i = 0; i < b.title.length; i++) hue = (hue * 31 + b.title.charCodeAt(i)) >>> 0;
            hue %= 360;
            return '<li class="book" data-id="' + esc(b.id) + '"><div class="cover">' +
                '<div class="gen" style="background:linear-gradient(160deg,hsl(' + hue + ',32%,30%),hsl(' + ((hue + 40) % 360) + ',38%,16%))">' + esc(b.title) + '<small>' + esc(b.author) + '</small></div>' +
                (p && pct < 100 ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') + '</div>' +
                '<div class="title">' + esc(b.title) + '</div>' +
                '<div class="meta">' + esc(b.author || b.format.toUpperCase()) + '</div>' +
                '<div class="meta">' + b.format.toUpperCase() + (b.size ? ' · ' + size(b.size) : '') + ' · ' + state + '</div>' +
                '<div class="actions"><button data-act="edit">Edit</button><button data-act="delete" class="danger">Remove</button></div></li>';
        }).join('');
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
        var li = document.createElement('li');
        li.innerHTML = '<span class="name">' + esc(name) + '</span><span class="state">Waiting…</span><div class="bar"><i></i></div>';
        $('queue').appendChild(li);
        return {
            state: function (text, kind) { var s = li.querySelector('.state'); s.textContent = text; s.className = 'state' + (kind ? ' ' + kind : ''); },
            bar: function (f) { li.querySelector('.bar i').style.width = (f * 100).toFixed(1) + '%'; },
            done: function () { setTimeout(function () { li.remove(); }, 4000); }
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

    /* ---- Wiring --------------------------------------------------------------------- */

    $('signIn').addEventListener('click', function () { signIn(false); }); // not signIn(event): that reads as "restored"
    $('signOut').addEventListener('click', signOut);
    $('fromDrive').addEventListener('click', pickFromDrive);
    $('pick').addEventListener('change', function (e) { addAll(Array.prototype.slice.call(e.target.files)); e.target.value = ''; });
    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
    drop.addEventListener('drop', function (e) {
        e.preventDefault();
        if (e.dataTransfer && e.dataTransfer.files.length) addAll(Array.prototype.slice.call(e.dataTransfer.files));
    });

    $('books').addEventListener('click', async function (e) {
        var btn = e.target.closest('button');
        if (!btn) return;
        var li = btn.closest('.book'), id = li.getAttribute('data-id');
        var book = books.filter(function (b) { return b.id === id; })[0];
        var act = btn.getAttribute('data-act');
        if (act === 'delete') {
            btn.textContent = 'Really remove?';
            btn.className = 'confirm';
            btn.setAttribute('data-act', 'confirm');
            setTimeout(function () {
                if (btn.isConnected && btn.getAttribute('data-act') === 'confirm') { btn.textContent = 'Remove'; btn.className = 'danger'; btn.setAttribute('data-act', 'delete'); }
            }, 4000);
        } else if (act === 'confirm') {
            // Same rule as the TV: uploaded → Drive trash; picked → just unmarked.
            if (book.parents.indexOf(folders.root) !== -1) await drive.update(id, { trashed: true });
            else await drive.update(id, { appProperties: { bookshelf: null, cover: null } });
            if (book.coverId) drive.update(book.coverId, { trashed: true }).catch(function () {});
            await load();
        } else if (act === 'edit') {
            var box = document.createElement('div');
            box.className = 'edit';
            box.innerHTML = '<input name="title" placeholder="Title"><input name="author" placeholder="Author">' +
                '<div class="actions"><button data-act="save">Save</button><button data-act="cancel">Cancel</button></div>';
            box.querySelector('[name=title]').value = book.title;
            box.querySelector('[name=author]').value = book.author || '';
            li.querySelector('.actions').replaceWith(box);
            box.querySelector('input').focus();
        } else if (act === 'save') {
            var title = li.querySelector('[name=title]').value.trim() || book.title;
            var author = li.querySelector('[name=author]').value.trim();
            await drive.update(id, { appProperties: { title: fit('title', title), author: author ? fit('author', author) : null } });
            await load();
        } else if (act === 'cancel') {
            render();
        }
    });

    if (mock) signIn(); // tests: no sign-in window
    else if ((token = savedToken())) signIn(true); // reloaded within the hour: still signed in
})();
