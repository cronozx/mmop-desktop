import {
  findBlockedUsernameWord,
  isUsernameClean,
  normalizeForUsernameMatch,
} from '../config/usernameFilter.js';

// Pure-function tests for the shared username word filter.

describe('normalizeForUsernameMatch', () => {
  it('lowercases, folds leetspeak, and strips separators', () => {
    expect(normalizeForUsernameMatch('Sh1t')).toBe('shit');
    expect(normalizeForUsernameMatch('n_a_z_i')).toBe('nazi');
    expect(normalizeForUsernameMatch('f@ggot')).toBe('fagot');
  });

  it('collapses repeated letters', () => {
    expect(normalizeForUsernameMatch('niiigger')).toBe('niger');
  });
});

describe('findBlockedUsernameWord', () => {
  it('flags obvious slurs and profanity', () => {
    expect(findBlockedUsernameWord('totalnazi')).toBe('nazi');
    expect(findBlockedUsernameWord('5h1tlord')).toBe('shit');
  });

  it('returns null for clean usernames', () => {
    expect(findBlockedUsernameWord('cronozx')).toBeNull();
    expect(findBlockedUsernameWord('player-1234')).toBeNull();
    expect(findBlockedUsernameWord('')).toBeNull();
  });
});

describe('isUsernameClean', () => {
  it('is the inverse of finding a blocked word', () => {
    expect(isUsernameClean('coolplayer')).toBe(true);
    expect(isUsernameClean('f4ggot')).toBe(false);
  });
});
