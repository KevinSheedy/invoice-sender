// In-memory stand-ins for the Apps Script services Code.gs uses, so the backend can be
// tested and run locally with Node. Only the calls Code.gs makes are implemented.
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const CODE_PATH = new URL('../apps-script/Code.gs', import.meta.url);

class Blob {
  constructor(data, contentType, name) {
    this.data = data;
    this.contentType = contentType;
    this.name = name;
  }
  getAs(contentType) { return new Blob(this.data, contentType, this.name); }
  setName(name) { this.name = name; return this; }
  getName() { return this.name; }
  getContentType() { return this.contentType; }
  getDataAsString() { return this.data; }
}

class Range {
  constructor(sheet, row, col, numRows, numCols) {
    if (numRows < 1 || numCols < 1) throw new Error('The number of rows or columns in the range must be at least 1.');
    if (row + numRows - 1 > sheet.maxRows) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.data[this.row - 1 + r] || [];
      const row = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        row.push(v === undefined ? '' : v);
      }
      out.push(row);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values[0].length !== this.numCols) throw new Error('Range size mismatch');
    values.forEach((vals, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.data.length <= idx) this.sheet.data.push([]);
      vals.forEach((v, c) => { this.sheet.data[idx][this.col - 1 + c] = v; });
    });
    return this;
  }
  setNumberFormat() { return this; }
  setFontWeight() { return this; }
}

class Sheet {
  constructor(name) { this.name = name; this.data = []; this.maxRows = 1000; }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getLastRow() {
    for (let i = this.data.length - 1; i >= 0; i--) {
      if ((this.data[i] || []).some(v => v !== '' && v !== undefined)) return i + 1;
    }
    return 0;
  }
  getLastColumn() { return Math.max(0, ...this.data.map(r => r.length)); }
  getRange(row, col, numRows = 1, numCols = 1) { return new Range(this, row, col, numRows, numCols); }
  insertRowsAfter(after, n) { this.maxRows += n; }
  deleteRow(row) { this.data.splice(row - 1, 1); }
  setFrozenRows() {}
}

class Spreadsheet {
  constructor(id) { this.id = id; this.sheets = [new Sheet('Sheet1')]; }
  getId() { return this.id; }
  getSheets() { return this.sheets; }
  getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }
  insertSheet(name) { const s = new Sheet(name); this.sheets.push(s); return s; }
  deleteSheet(sheet) { this.sheets = this.sheets.filter(s => s !== sheet); }
}

export function createBackend({ driveUrlBase = 'https://drive.example/file/', log = () => {} } = {}) {
  const props = new Map();
  const files = new Map();
  const mail = { drafts: [], sent: [] };
  const spreadsheet = new Spreadsheet('sheet-1');
  let folders = 0;
  let drafts = 0;

  const globals = {
    console,
    Logger: { log },
    MimeType: { HTML: 'text/html', PDF: 'application/pdf' },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: content => ({ content, setMimeType() { return this; }, getContent: () => content }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    Session: { getScriptTimeZone: () => 'Europe/Dublin' },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: id => {
        if (id !== spreadsheet.id) throw new Error('Spreadsheet not found');
        return spreadsheet;
      },
      create: () => spreadsheet,
    },
    DriveApp: {
      createFolder: name => {
        const id = 'folder-' + ++folders;
        return makeFolder(id, name);
      },
      getFolderById: id => {
        if (!id.startsWith('folder-') || Number(id.slice(7)) > folders) throw new Error('No folder');
        return makeFolder(id);
      },
      getFileById: id => {
        const f = files.get(id);
        if (!f) throw new Error('No file');
        return { getBlob: () => f.blob, getName: () => f.blob.getName(), setTrashed: v => { f.trashed = v; } };
      },
    },
    Utilities: {
      newBlob: (data, type, name) => new Blob(data, type, name),
      getUuid: () => randomUUID(),
      formatDate: (date, tz, format) => {
        if (!/^yyyy([-/])MM\1dd$/.test(format)) throw new Error('Fake formatDate only supports yyyy-MM-dd and yyyy/MM/dd');
        const iso = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
        return iso.replace(/-/g, format[4]);
      },
    },
    GmailApp: {
      createDraft: (to, subject, body, options) => {
        const id = 'draft-' + ++drafts;
        mail.drafts.push({ id, to, subject, body, options });
        return { getId: () => id };
      },
      getDraft: id => {
        if (!mail.drafts.some(d => d.id === id)) throw new Error('No draft');
        return { deleteDraft: () => { mail.drafts = mail.drafts.filter(d => d.id !== id); } };
      },
      sendEmail: (to, subject, body, options) => { mail.sent.push({ to, subject, body, options, date: context.now_() }); },
      search: query => {
        const m = query.match(/^in:sent to:(\S+) has:attachment after:\d{4}\/\d{2}\/\d{2}$/);
        if (!m) throw new Error('Fake search does not understand: ' + query);
        return mail.sent
          .filter(s => s.to === m[1])
          .map(s => ({ getMessages: () => [{ getDate: () => s.date, getAttachments: () => s.options.attachments }] }));
      },
    },
  };

  function makeFolder(id) {
    return {
      getId: () => id,
      createFile: blob => {
        const fileId = 'file-' + (files.size + 1);
        files.set(fileId, { blob, url: driveUrlBase + fileId });
        return { getId: () => fileId, getUrl: () => driveUrlBase + fileId };
      },
    };
  }

  const context = vm.createContext(globals);
  vm.runInContext(readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.gs' });

  return {
    context,
    props,
    files,
    mail,
    spreadsheet,
    // Simulates tapping Send on a Gmail draft in the phone's Gmail app.
    sendDraft(index = 0) {
      const [draft] = mail.drafts.splice(index, 1);
      mail.sent.push({ ...draft, date: context.now_() });
    },
    setNow(isoString) {
      vm.runInContext(`now_ = function () { return new Date(${JSON.stringify(isoString)}); };`, context);
    },
    call(action, data, key = props.get('API_KEY')) {
      const out = context.doPost({ postData: { contents: JSON.stringify({ key, action, data }) } });
      return JSON.parse(out.getContent());
    },
  };
}
