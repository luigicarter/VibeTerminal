'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeTerminalKeys, validateTerminalControls, encodeTerminalControls } = require('../../shared/terminalControls.cjs');
const { normalizeIntent, authorizeIntentAction } = require('../../backend/orchestratorIntent.cjs');
test('named control normalization preserves semantics without expanding key vocabulary', () => {
 const input=[' Ctrl-E ','Ctrl-U','Backspace']; const normalized=normalizeTerminalKeys(input);
 assert.deepEqual(normalized,['ctrl-e','ctrl-u','backspace']); assert.deepEqual(input,[' Ctrl-E ','Ctrl-U','Backspace']);
 assert.equal(validateTerminalControls({keys:normalized}).ok,true);
 assert.equal(encodeTerminalControls({keys:normalized}).data,encodeTerminalControls({keys:['ctrl-e','ctrl-u','backspace']}).data);
 for(const value of [undefined,null,'Ctrl-C',42]) assert.equal(normalizeTerminalKeys(value),value);
 for(const keys of [[42],['Ctrl+U'],['raw command'],['\x03'],['Control-U']]) assert.equal(validateTerminalControls({keys:normalizeTerminalKeys(keys)}).ok,false);
});
test('canonicalized casing cannot bypass preserve lifecycle authority', () => {
 const sessions=[{id:'a',generation:'g',kind:'codex'}];
 const plan=normalizeIntent({goal:'Clear input',actions:[{kind:'operate_terminal',targetIds:['a'],text:'Clear the unsent text'}]},{instruction:'Clear the unsent text',requestId:'r',sessions});
 for(const key of ['Ctrl-C',' CTRL-D ','Ctrl-Backslash','Ctrl-Z']) assert.throws(()=>authorizeIntentAction({kind:'terminal_interact',grantId:plan.grants[0].id,stepId:key,observationSequence:1,inputRevision:0,editInput:true,keys:normalizeTerminalKeys([key])},plan,sessions),/preserve/);
});
