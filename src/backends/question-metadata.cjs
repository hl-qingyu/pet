const MAX_ITEMS = 64, MAX_QUESTIONS = 32;
const OPEN = '<send_user_message_question_reply>', CLOSE = '</send_user_message_question_reply>';
// The desktop also uses tail:<generation>:local:<id> for turns whose server
// identity has not been attached. These contain the same status and items.
const isTurnKey = key => typeof key === 'string' && /^(?:turn:|legacy:|pending:|tail:)/.test(key);

// Identify status-bearing item patches without opening arbitrary message bodies.
function itemPath(path) {
  let offset;
  if (path[0] === 'turns' && Number.isInteger(path[1])) offset = 2;
  else if (path[0] === 'turnHistory' && path[1] === 'history' && path[2] === 'entitiesByKey' &&
    isTurnKey(path[3])) offset = 4;
  else return null;
  if (path.length === offset) return { role: 'turn', offset };
  if (path[offset] !== 'items') return null;
  if (path.length === offset + 1) return { role: 'items', offset };
  if (!Number.isInteger(path[offset + 1]) || path[offset + 1] < 0) return null;
  if (path.length === offset + 2) return { role: 'item', offset };
  if (path.length === offset + 3 && path[offset + 2] === 'questions') return { role: 'questions', offset };
  return { role: 'detail', offset };
}

// Decode one outer JSON string incrementally. Only the structured reply's IDs
// enter the nested projection; question and answer text are always discarded.
class QuestionReply {
  constructor(Parser) { this.Parser = Parser; this.stage = 'search'; this.match = 0; this.escape = ''; }
  feed(char) {
    if (this.escape) {
      this.escape += char;
      if (this.escape === '\\u' || (this.escape.startsWith('\\u') && this.escape.length < 6)) return;
      char = JSON.parse('"' + this.escape + '"'); this.escape = '';
    } else if (char === '\\') { this.escape = char; return; }
    this.decoded(char);
  }
  decoded(char) {
    if (this.stage === 'invalid') return;
    if (this.stage === 'search') {
      this.match = char === OPEN[this.match] ? this.match + 1 : char === OPEN[0] ? 1 : 0;
      if (this.match === OPEN.length) {
        this.stage = 'json'; this.match = 0;
        this.parser = new this.Parser({ keys: new Set(['questionItemId']), maxNodes: 128, maxDepth: 16 });
      }
    } else if (this.stage === 'json') {
      if (this.parser.rootDone && !this.parser.stack.length && !this.parser.string && char === '<') {
        try {
          const value = this.parser.finish(), entries = Array.isArray(value) ? value : [value];
          if (!entries.length || entries.length > MAX_QUESTIONS) throw new Error('reply-limit');
          this.ids = entries.map(entry => {
            const id = entry?.questionItemId, parts = JSON.parse(id);
            if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== 'request_user_input_async' ||
              typeof parts[1] !== 'string' || !Number.isInteger(parts[2]) || parts[2] < 0) throw new Error('reply-id');
            return id;
          });
          this.parser = null; this.stage = 'close'; this.match = 1;
        } catch { this.stage = 'invalid'; this.parser = null; }
      } else {
        try { this.parser.feedText(char); } catch { this.stage = 'invalid'; this.parser = null; }
      }
    } else if (this.stage === 'close') {
      if (char !== CLOSE[this.match++]) this.stage = 'invalid';
      else if (this.match === CLOSE.length) this.stage = 'done';
    } else if (!/\s/.test(char)) this.stage = 'invalid';
  }
  finish() { return this.stage === 'done' ? this.ids : []; }
}

function compactItem(item, index) {
  if (item.type === 'agentMessage' && item.questions > 0) {
    if (typeof item.id !== 'string') throw new Error('question-id');
    return { index, id: item.id, questions: item.questions };
  }
  if (item.type === 'userMessage') return { index, type: item.type, replyIds: item.replyIds };
  if (item.type === 'steeringUserMessage') return { index, replyIds: item.replyIds,
    type: item.type, status: item.status, steerAcknowledged: item.steerAcknowledged };
  return null;
}

module.exports = { isTurnKey, itemPath, QuestionReply, compactItem, MAX_ITEMS, MAX_QUESTIONS };
