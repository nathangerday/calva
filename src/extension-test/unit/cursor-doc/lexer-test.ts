import * as assert from 'assert';
import { LexicalGrammar } from '../../../cursor-doc/lexer';

describe('LexicalGrammar positional matching', () => {
  it('keeps longest-match precedence and the first rule for equal matches', () => {
    const grammar = new LexicalGrammar();
    grammar.terminal('short', /a/, () => ({ type: 'short' }));
    grammar.terminal('long', /ab/, () => ({ type: 'long' }));
    grammar.terminal('equal', /ab/, () => ({ type: 'equal' }));
    const lexer = grammar.lex('abab', 100);
    assert.deepStrictEqual(lexer.scan(), { type: 'long', offset: 0, raw: 'ab' });
    assert.deepStrictEqual(lexer.scan(), { type: 'long', offset: 2, raw: 'ab' });
    assert.strictEqual(lexer.scan(), null);
  });

  it('preserves anchors and lookbehind at nonzero offsets', () => {
    const grammar = new LexicalGrammar();
    grammar.terminal('start', /^a/, () => ({ type: 'start' }));
    grammar.terminal('after-a', /(?<=a)b/, () => ({ type: 'after-a' }));
    grammar.terminal('char', /./, () => ({ type: 'char' }));
    const lexer = grammar.lex('abaa', 100);
    assert.strictEqual(lexer.scan().type, 'start');
    assert.strictEqual(lexer.scan().type, 'after-a');
    assert.strictEqual(lexer.scan().type, 'char');
    assert.strictEqual(lexer.scan().type, 'char');
  });

  it('rejects a token that only matches later in the input', () => {
    const grammar = new LexicalGrammar();
    grammar.terminal('token', /b/, () => ({ type: 'token' }));
    assert.throws(() => grammar.lex('ab', 100).scan(), /Unexpected character at 0/);
  });
});
