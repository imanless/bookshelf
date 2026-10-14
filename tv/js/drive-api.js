/* Bookshelf — the small part of the Google Drive API both the TV (Drive
   version) and the Drive upload page use. The app only has "drive.file"
   access: it sees exactly the files it created or was given (uploaded into
   the "Bookshelf" folder, or picked from anywhere in Drive). Covers live in
   "Bookshelf/covers", reading progress in "Bookshelf/progress.json".

   Book files are marked and described with appProperties (each ≤ 124 bytes,
   visible only to this app):
     { bookshelf: '1', format: 'pdf'|'epub', title, author, cover: <file id> } */
(function () {
    'use strict';
    var App = window.App = window.App || {};
    var FOLDER_MIME = 'application/vnd.google-apps.folder';

    // getToken() → Promise<access token>; onUnauthorized() is called once on a
    // 401 (to drop a stale token) before one retry.
    App.DriveApi = function (base, getToken, onUnauthorized) {
        function q(s) { return encodeURIComponent(s); }

        async function call(path, opts, retried) {
            var o = Object.assign({}, opts || {});
            o.headers = Object.assign({ Authorization: 'Bearer ' + (await getToken()) }, o.headers || {});
            var r = await fetch(base + path, o);
            if (r.status === 401 && !retried && onUnauthorized) {
                onUnauthorized();
                return call(path, opts, true);
            }
            if (!r.ok) {
                var err = new Error('Google Drive answered ' + r.status);
                err.status = r.status;
                throw err;
            }
            return r;
        }
        function json(path, opts) { return call(path, opts).then(function (r) { return r.json(); }); }
        function jsonBody(method, obj) { return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) }; }

        var api = {
            raw: call,
            json: json,

            about: function () { return json('/drive/v3/about?fields=' + q('user(displayName,emailAddress)')); },

            list: function (query, fields) {
                return json('/drive/v3/files?q=' + q(query) + '&fields=' + q('files(' + fields + ')') +
                    '&pageSize=1000&orderBy=' + q('createdTime desc')).then(function (r) { return r.files || []; });
            },

            folder: async function (name, parent) {
                var found = await api.list("name='" + name + "' and mimeType='" + FOLDER_MIME + "' and trashed=false" + (parent ? " and '" + parent + "' in parents" : ''), 'id');
                if (found.length) return found[0].id;
                var meta = { name: name, mimeType: FOLDER_MIME };
                if (parent) meta.parents = [parent];
                return (await json('/drive/v3/files?fields=id', jsonBody('POST', meta))).id;
            },

            // The Bookshelf folder and its covers subfolder (created on first use).
            folders: async function () {
                var root = await api.folder('Bookshelf');
                return { root: root, covers: await api.folder('covers', root) };
            },

            create: function (meta, content, type) {
                var boundary = 'bookshelf' + Math.random().toString(16).slice(2);
                var body = new Blob(['--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
                    '\r\n--' + boundary + '\r\nContent-Type: ' + (type || 'application/octet-stream') + '\r\n\r\n', content, '\r\n--' + boundary + '--\r\n']);
                return json('/upload/drive/v3/files?uploadType=multipart&fields=id', {
                    method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + boundary }, body: body
                });
            },

            replace: function (id, content, type) {
                return json('/upload/drive/v3/files/' + id + '?uploadType=media&fields=id', { method: 'PATCH', headers: { 'Content-Type': type }, body: content });
            },

            update: function (id, meta) { return json('/drive/v3/files/' + id + '?fields=id', jsonBody('PATCH', meta)); },

            media: function (id) { return call('/drive/v3/files/' + id + '?alt=media'); }
        };
        return api;
    };

    App.DriveApi.FOLDER_MIME = FOLDER_MIME;
    App.DriveApi.BOOKS = "appProperties has { key='bookshelf' and value='1' } and trashed=false";
    App.DriveApi.BOOK_FIELDS = 'id,name,size,mimeType,createdTime,modifiedTime,appProperties,parents';

    // A Drive file → a library book (null if it isn't a PDF or EPUB).
    App.DriveApi.toBook = function (file) {
        var ap = file.appProperties || {};
        var format = ap.format ||
            (/\.epub$/i.test(file.name) || file.mimeType === 'application/epub+zip' ? 'epub' :
                /\.pdf$/i.test(file.name) || file.mimeType === 'application/pdf' ? 'pdf' : '');
        if (!format) return null;
        return {
            id: file.id, format: format,
            title: ap.title || String(file.name || 'Untitled').replace(/\.(pdf|epub)$/i, '').replace(/_+/g, ' ').trim(),
            author: ap.author || '', size: Number(file.size) || 0, added: Date.parse(file.createdTime) || 0,
            cover: !!ap.cover, coverId: ap.cover || '', parents: file.parents || []
        };
    };
})();
