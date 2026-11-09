const fs = require('node:fs');
const { atomicWrite } = require('./config.cjs');

class History {
  constructor(file) {
    this.file = file; this.messages = [];
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(data) || !data.every(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')) throw new Error('聊天记录格式无效');
      this.messages = data.slice(-400);
    }
  }
  context(count) {
    const recent = this.messages.slice(-count);
    if (recent[0]?.role === 'assistant') recent.shift();
    return recent.map(({ role, content }) => ({ role, content }));
  }
  append(user, assistant, save, character) {
    const at = new Date().toISOString();
    const author = character ? { characterId: character.id, characterName: character.name } : {};
    this.messages.push({ role: 'user', content: user, at }, { role: 'assistant', content: assistant, at, ...author });
    this.messages = this.messages.slice(-400);
    if (save) atomicWrite(this.file, this.messages);
  }
  clear() { this.messages = []; if (fs.existsSync(this.file)) atomicWrite(this.file, []); }
}
module.exports = { History };
