const { StringDecoder } = require('node:string_decoder');
const { isTurnKey, itemPath, QuestionReply, compactItem, MAX_ITEMS, MAX_QUESTIONS } = require('./question-metadata.cjs');

const KEYS = new Set(['type', 'method', 'version', 'requestId', 'resultType', 'error', 'handledByClientId',
  'sourceClientId', 'result', 'clientId', 'clientType', 'params', 'conversationId', 'hostId', 'following',
  'status', 'isSelf', 'change', 'revision', 'baseRevision', 'conversationState', 'patches', 'op', 'path', 'value',
  'id', 'turnId', 'turns', 'requests', 'externalRequests', 'completedAtMs', 'turnStartedAtMs', 'durationMs',
  'hasUnreadTurn', 'threadRuntimeStatus', 'activeFlags', 'turnHistory', 'kind', 'history', 'entitiesByKey',
  'islands', 'entries', 'key', 'unconfirmedTurnSubmissions', 'terminal', 'updatedAt', 'recencyAt', 'cwd']);

// Streaming JSON projection. Discarded strings are never accumulated; skipped
// objects still have their grammar checked. Each frame produces only a bounded
// temporary metadata tree, including patch paths, never a transcript object.
class JsonMetadata {
  constructor({ maxNodes = 4096, maxString = 256, maxDepth = 64, keys = KEYS, questions = false } = {}) {
    Object.assign(this, { maxNodes, maxString, maxDepth, keys, questions });
    this.decoder = new StringDecoder('utf8'); this.stack = []; this.result = undefined;
    this.rootDone = false; this.nodes = 0; this.token = ''; this.string = false; this.escape = false;
    this.unicode = 0; this.tooLong = false; this.atom = false;
  }
  valueContext() {
    const parent = this.stack.at(-1);
    if (!parent) {
      if (this.rootDone) throw new Error('extra-json');
      return { keep: true, key: '', parent: null };
    }
    if (!['value', 'firstValue'].includes(parent.expect)) throw new Error('expected-value');
    const key = parent.kind === 'array' ? parent.index : parent.key;
    let keep = parent.keep && (parent.kind === 'array' ||
      (parent.name === 'entitiesByKey' ? isTurnKey(key) : this.keys.has(key)));
    if (key === 'params' && this.stack.length !== 1) keep = false;
    if (key === 'value' && Array.isArray(parent.out?.path) &&
      parent.out.path.some(part => ['items', 'content', 'input', 'params', 'title', 'text', 'summary', 'acceptedTextChanges'].includes(part))) keep = false;
    if (this.questions && key === 'value' && itemPath(parent.out?.path || [])?.role === 'detail' &&
      ['status', 'steerAcknowledged'].includes(parent.out.path.at(-1))) keep = true;
    if (parent.role === 'item') keep = ['type', 'id', 'status', 'steerAcknowledged'].includes(key);
    return { parent, key, keep };
  }
  put(value, context) {
    const { parent, key, keep } = context;
    if (keep && parent?.role !== 'items' && ++this.nodes > this.maxNodes) throw new Error('metadata-limit');
    if (!parent) { this.result = value; this.rootDone = true; }
    else {
      if (keep && parent.role !== 'items') parent.out[key] = value;
      parent.expect = 'comma';
      if (parent.kind === 'array') parent.index++;
    }
  }
  startContainer(kind) {
    const context = this.valueContext(), parent = context.parent;
    let role;
    if (this.questions) {
      if (context.key === 'value' && parent.out?.path) role = parent.out.path.length === 1 && parent.out.path[0] === 'turns' ? 'turns' : itemPath(parent.out.path)?.role;
      else if (parent?.role === 'items' && kind === 'object') role = 'item';
      else if (parent?.role === 'content' && kind === 'object') role = 'text';
      else if (parent?.role === 'item' && context.key === 'questions' && kind === 'array') role = 'questions';
      else if (parent?.role === 'item' && ['content', 'input'].includes(context.key) && kind === 'array') role = 'content';
      else if (parent?.role === 'turn' && context.key === 'items' && kind === 'array') role = 'items';
      else if (context.keep && (parent?.role === 'turns' || parent?.name === 'turns' || parent?.name === 'entitiesByKey')) role = 'turn';
      if (['items', 'item'].includes(role)) context.keep = true;
      if (['questions', 'content', 'text', 'detail'].includes(role)) context.keep = false;
    }
    const budget = this.nodes, out = context.keep ? (kind === 'array' ? [] : Object.create(null)) : null;
    this.put(out, context);
    if (this.stack.length >= this.maxDepth) throw new Error('json-depth');
    this.stack.push({ kind, keep: context.keep, out, role, budget, parent, slot: context.key,
      item: role === 'content' ? parent : role === 'text' ? parent.item : null,
      name: String(context.key), index: 0, key: '', expect: kind === 'array' ? 'firstValue' : 'firstKey' });
  }
  endContainer(kind) {
    const parent = this.stack.at(-1);
    if (!parent || parent.kind !== kind || !['comma', kind === 'array' ? 'firstValue' : 'firstKey'].includes(parent.expect)) throw new Error('json-container');
    this.stack.pop();
    if (parent.role === 'questions') {
      if (parent.index > MAX_QUESTIONS) throw new Error('question-limit');
      parent.parent.out[parent.slot] = parent.index;
    } else if (parent.role === 'item') {
      this.nodes = parent.budget;
      const item = compactItem(parent.out, parent.slot);
      if (parent.parent.role === 'items') {
        if (item) {
          if (parent.parent.out.length >= MAX_ITEMS) throw new Error('question-item-limit');
          parent.parent.out.push(item); this.nodes += 4;
          if (this.nodes > this.maxNodes) throw new Error('metadata-limit');
        }
      } else parent.parent.out[parent.slot] = item;
    }
  }
  punctuation(char) {
    const parent = this.stack.at(-1);
    if (char === '{') this.startContainer('object');
    else if (char === '[') this.startContainer('array');
    else if (char === '}') this.endContainer('object');
    else if (char === ']') this.endContainer('array');
    else if (char === ':') {
      if (parent?.kind !== 'object' || parent.expect !== 'colon') throw new Error('json-colon');
      parent.expect = 'value';
    } else if (char === ',') {
      if (!parent || parent.expect !== 'comma') throw new Error('json-comma');
      parent.expect = parent.kind === 'array' ? 'value' : 'key';
    }
  }
  beginString() {
    const parent = this.stack.at(-1);
    this.isKey = parent?.kind === 'object' && ['firstKey', 'key'].includes(parent.expect);
    const context = this.isKey ? null : this.valueContext();
    this.capture = this.isKey || context.keep;
    this.reply = !this.isKey && parent?.role === 'text' && context.key === 'text' ? new QuestionReply(JsonMetadata) : null;
    // Paths have the same 1000-character limit as the settings field. Other
    // strings keep the tighter metadata budget, including message/turn IDs.
    this.stringLimit = context && (context.key === 'cwd' || (context.key === 'value' &&
      parent.out?.path?.length === 1 && parent.out.path[0] === 'cwd')) ? 1000 : this.maxString;
    this.string = true; this.escape = false; this.unicode = 0; this.tooLong = false; this.token = '"';
  }
  finishString() {
    let value = null;
    if (this.capture && !this.tooLong) value = JSON.parse(this.token + '"');
    if (typeof value === 'string' && value.length > this.stringLimit) { this.tooLong = true; value = null; }
    if (this.isKey) {
      const parent = this.stack.at(-1); parent.key = value ?? ''; parent.expect = 'colon';
    } else {
      const context = this.valueContext();
      if (this.tooLong && context.keep) throw new Error('metadata-string-limit');
      this.put(value, context);
      if (this.reply) {
        const ids = this.reply.finish();
        if (ids.length) {
          const item = context.parent.item.out;
          item.replyIds = [...(item.replyIds || []), ...ids];
          if (item.replyIds.length > MAX_QUESTIONS) throw new Error('reply-limit');
        }
      }
    }
    this.string = false; this.token = ''; this.reply = null;
  }
  finishAtom() {
    if (!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(this.token)) throw new Error('json-atom');
    this.put(JSON.parse(this.token), this.valueContext()); this.atom = false; this.token = '';
  }
  feed(buffer) {
    this.feedText(this.decoder.write(buffer));
  }
  feedText(text) {
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (this.string) {
        if (this.unicode) {
          if (!/[\da-fA-F]/.test(char)) throw new Error('json-unicode');
          this.unicode--;
        } else if (this.escape) {
          if (!'"\\/bfnrtu'.includes(char)) throw new Error('json-escape');
          if (char === 'u') this.unicode = 4;
          this.escape = false;
        } else if (char === '\\') this.escape = true;
        else if (char === '"') { this.finishString(); continue; }
        else if (char.charCodeAt(0) < 32) throw new Error('json-control');
        this.reply?.feed(char);
        if (this.capture && !this.tooLong) {
          this.token += char;
          if (this.token.length > this.stringLimit * 6 + 2) { this.tooLong = true; this.token = ''; }
        }
        continue;
      }
      if (this.atom) {
        if (/[\s,\]}]/.test(char)) { this.finishAtom(); i--; continue; }
        this.token += char;
        if (this.token.length > 64) throw new Error('json-atom-limit');
        continue;
      }
      if (/\s/.test(char)) continue;
      if (char === '"') this.beginString();
      else if ('{}[]:,'.includes(char)) this.punctuation(char);
      else { this.valueContext(); this.atom = true; this.token = char; }
    }
  }
  finish() {
    if (this.decoder.lastNeed || this.string || this.stack.length) throw new Error('incomplete-json');
    if (this.atom) this.finishAtom();
    if (!this.rootDone) throw new Error('empty-json');
    return this.result;
  }
}
module.exports = { JsonMetadata };
