/* Bookshelf — title, author and a cover image from a book file, in the
   browser. Without the Mac there is no server to make covers: the Drive
   upload page uses this before uploading, and the TV after downloading a book
   that has no cover yet. Needs fflate; loads pdf.js on demand. */
(function () {
    'use strict';
    var App = window.App = window.App || {};
    var COVER_MAX = 900; // longest side, px

    var BookMeta = App.BookMeta = { pdfjsBase: 'vendor/pdfjs/' };

    function titleFromName(name) {
        return String(name || 'Untitled').replace(/\.(pdf|epub)$/i, '').replace(/_+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled';
    }

    function sniff(u8, name) {
        var head = new TextDecoder('latin1').decode(u8.subarray(0, 1024));
        if (head.indexOf('%PDF-') !== -1) return 'pdf';
        if (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 3 && u8[3] === 4) {
            if (head.indexOf('application/epub+zip') !== -1 || /\.epub$/i.test(name || '')) return 'epub';
        }
        return null;
    }

    function loadPdfjs() {
        if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
        if (!BookMeta._pdfjs) {
            BookMeta._pdfjs = new Promise(function (resolve, reject) {
                var s = document.createElement('script');
                s.src = BookMeta.pdfjsBase + 'pdf.min.js';
                s.onload = function () {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc = BookMeta.pdfjsBase + 'pdf.worker.min.js';
                    resolve(window.pdfjsLib);
                };
                s.onerror = function () { BookMeta._pdfjs = null; reject(new Error('pdf.js missing')); };
                document.head.appendChild(s);
            });
        }
        return BookMeta._pdfjs;
    }

    function canvasJpeg(canvas) {
        return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/jpeg', 0.85); });
    }

    // Any image Blob → a JPEG no larger than COVER_MAX.
    async function shrink(blob) {
        var url = URL.createObjectURL(blob);
        try {
            var img = await new Promise(function (resolve, reject) {
                var i = new Image();
                i.onload = function () { resolve(i); };
                i.onerror = reject;
                i.src = url;
            });
            var k = Math.min(1, COVER_MAX / Math.max(img.naturalWidth, img.naturalHeight));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.naturalWidth * k));
            c.height = Math.max(1, Math.round(img.naturalHeight * k));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            return await canvasJpeg(c);
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    function xml(text) {
        var d = new DOMParser().parseFromString(text, 'application/xml');
        return d.getElementsByTagName('parsererror').length ? null : d;
    }
    function first(doc, tag) {
        var el = doc.getElementsByTagNameNS('*', tag)[0];
        return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
    }

    async function readEpub(u8) {
        var entry = function (name) {
            var out = fflate.unzipSync(u8, { filter: function (f) { return f.name === name; } });
            return out[name] || null;
        };
        var dec = new TextDecoder('utf-8');
        var container = entry('META-INF/container.xml');
        var rootfile = container && xml(dec.decode(container));
        var opfPath = rootfile && rootfile.getElementsByTagNameNS('*', 'rootfile')[0];
        opfPath = opfPath && opfPath.getAttribute('full-path');
        var opfBytes = opfPath && entry(opfPath);
        var opf = opfBytes && xml(dec.decode(opfBytes));
        if (!opf) return { title: '', author: '', cover: null };

        var items = Array.prototype.slice.call(opf.getElementsByTagNameNS('*', 'item'));
        var cover = items.filter(function (it) { return /(^|\s)cover-image(\s|$)/.test(it.getAttribute('properties') || ''); })[0];
        if (!cover) {
            var meta = Array.prototype.slice.call(opf.getElementsByTagNameNS('*', 'meta'))
                .filter(function (m) { return (m.getAttribute('name') || '').toLowerCase() === 'cover'; })[0];
            if (meta) cover = items.filter(function (it) { return it.getAttribute('id') === meta.getAttribute('content'); })[0];
        }
        if (!cover) {
            cover = items.filter(function (it) {
                return /^image\//.test(it.getAttribute('media-type') || '') && /cover/i.test((it.getAttribute('id') || '') + ' ' + (it.getAttribute('href') || ''));
            })[0];
        }
        var coverBlob = null;
        if (cover && /^image\/(jpeg|png|gif|webp)/.test(cover.getAttribute('media-type') || '')) {
            var base = opfPath.lastIndexOf('/') >= 0 ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
            var href = cover.getAttribute('href');
            try { href = decodeURIComponent(href); } catch (e) { /* as written */ }
            var parts = [];
            (base + href).split('/').forEach(function (p) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); });
            var bytes = entry(parts.join('/'));
            if (bytes) coverBlob = await shrink(new Blob([bytes], { type: cover.getAttribute('media-type') }));
        }
        return { title: first(opf, 'title'), author: first(opf, 'creator'), cover: coverBlob };
    }

    async function readPdf(u8) {
        var pdfjs = await loadPdfjs();
        // pdf.js takes over the buffer (no copy — big PDFs on a TV).
        var task = pdfjs.getDocument({ data: u8, isEvalSupported: false });
        var doc = await task.promise;
        try {
            var info = {};
            try { info = (await doc.getMetadata()).info || {}; } catch (e) { /* no metadata */ }
            var page = await doc.getPage(1);
            var vp1 = page.getViewport({ scale: 1 });
            var vp = page.getViewport({ scale: COVER_MAX / Math.max(vp1.width, vp1.height) });
            var c = document.createElement('canvas');
            c.width = Math.round(vp.width);
            c.height = Math.round(vp.height);
            await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
            // PDF titles are often junk ("Microsoft Word - draft3.doc").
            var title = String(info.Title || '').trim();
            if (!title || /^(untitled|microsoft word|document\d*$)|\.(docx?|pdf|indd|tex)$/i.test(title)) title = '';
            return { title: title, author: String(info.Author || '').trim(), cover: await canvasJpeg(c) };
        } finally {
            task.destroy();
        }
    }

    // → { format: 'pdf'|'epub', title, author, cover: Blob|null }
    BookMeta.read = async function (blob, name) {
        var u8 = new Uint8Array(await blob.arrayBuffer());
        var format = sniff(u8, name);
        if (!format) throw new Error('Only PDF and EPUB files can be added');
        var meta = { title: '', author: '', cover: null };
        try {
            meta = format === 'epub' ? await readEpub(u8) : await readPdf(u8);
        } catch (e) {
            console.warn('book details unreadable', e); // still usable, with a typographic cover
        }
        return { format: format, title: meta.title || titleFromName(name), author: meta.author || '', cover: meta.cover };
    };
})();
