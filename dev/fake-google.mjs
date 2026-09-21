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

export function createBackend({ log = () => {} } = {}) {
  const props = new Map();
  const drafts = [];

  const globals = {
    console,
    Logger: { log },
    MimeType: { HTML: 'text/html', PDF: 'application/pdf' },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: content => ({ setMimeType() { return this; }, getContent: () => content }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: k => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => { props.set(k, String(v)); },
      }),
    },
    Session: { getScriptTimeZone: () => 'Europe/Dublin' },
    Utilities: {
      newBlob: (data, type, name) => new Blob(data, type, name),
      getUuid: () => randomUUID(),
      formatDate: (date, tz, format) => {
        if (format !== 'yyyy-MM-dd') throw new Error('Fake formatDate only supports yyyy-MM-dd');
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
          .format(date);
      },
    },
    GmailApp: {
      createDraft: (to, subject, body, options) => { drafts.push({ to, subject, body, options }); },
    },
  };

  const context = vm.createContext(globals);
  vm.runInContext(readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.gs' });

  return {
    context,
    props,
    drafts,
    setNow(isoString) {
      vm.runInContext(`now_ = function () { return new Date(${JSON.stringify(isoString)}); };`, context);
    },
    call(action, data, key = props.get('API_KEY')) {
      const out = context.doPost({ postData: { contents: JSON.stringify({ key, action, data }) } });
      return JSON.parse(out.getContent());
    },
  };
}
