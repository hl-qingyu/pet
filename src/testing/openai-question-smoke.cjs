const fs = require('node:fs');
const path = require('node:path');

async function smokeOpenaiQuestions({ openaiFixture, petWindow, waitFor, getState, getObserver, dataRoot }) {
  const question = { type: 'agentMessage', id: 'async-smoke', text: 'PRIVATE_ASYNC_BODY',
    questions: [{ title: 'PRIVATE_QUESTION_ONE', options: ['PRIVATE_OPTION'] }, { title: 'PRIVATE_QUESTION_TWO' }] };
  const reply = indices => ({ type: 'userMessage', id: 'answer-' + indices.join('-'), content: [{ type: 'text',
    text: '<send_user_message_question_reply>' + JSON.stringify(indices.map(index => ({
      questionItemId: JSON.stringify(['request_user_input_async', question.id, index]), question: 'PRIVATE_QUESTION', answer: 'PRIVATE_ANSWER',
    }))) + '</send_user_message_question_reply>' }] });
  const row = y => petWindow.webContents.executeJavaScript(`getComputedStyle(document.querySelector('#sprite')).backgroundPositionY === '${y}px'`);
  const permission = { id: 'permission-one', method: 'item/permissions/requestApproval', params: { reason: 'PRIVATE_REASON' } };
  const command = { id: 'command-two', method: 'item/commandExecution/requestApproval', params: { command: 'PRIVATE_COMMAND' } };
  openaiFixture.update('running', [permission, command]);
  await waitFor(() => getState() === 'waiting'); await waitFor(() => row(-1248));
  fs.writeFileSync(path.join(dataRoot, 'permission-approval-waiting-smoke.png'), (await petWindow.webContents.capturePage()).toPNG());
  openaiFixture.update('running', [command]);
  await waitFor(() => [...getObserver().sessions.values()][0]?.summary.requests.length === 1);
  if (getState() !== 'waiting') throw new Error('仍有权限审批时必须保持等待动画');
  openaiFixture.update('running');
  await waitFor(() => getState() === 'running'); await waitFor(() => row(-1456));
  openaiFixture.update('running', [], [question]);
  await waitFor(() => getState() === 'waiting'); await waitFor(() => row(-1248));
  fs.writeFileSync(path.join(dataRoot, 'async-question-waiting-smoke.png'), (await petWindow.webContents.capturePage()).toPNG());
  openaiFixture.patchItems([question, reply([0])]);
  await waitFor(() => [...getObserver().sessions.values()][0]?.summary.turn.questionItems.length === 2);
  if (getState() !== 'waiting') throw new Error('异步问题只回答一部分时必须保持等待动画');
  openaiFixture.patchItems([question, reply([0]), reply([1])]);
  await waitFor(() => getState() === 'running'); await waitFor(() => row(-1456));
  if (JSON.stringify([...getObserver().sessions.values()]).includes('PRIVATE')) throw new Error('异步问题和答复正文不得保留');
  openaiFixture.update('running', ['restore']); await waitFor(() => getState() === 'waiting');
  return { permissionApprovalWaitingAnimation: true, concurrentApprovalsStillWaiting: true, approvalResolvedResumesWorking: true,
    asyncQuestionWaitingAnimation: true, canonicalTailSnapshotsAndPatches: true, partialAnswerStillWaiting: true, answeredResumesWorkingAnimation: true,
    noQuestionOrAnswerTextRetained: true, pass: true };
}
module.exports = { smokeOpenaiQuestions };
