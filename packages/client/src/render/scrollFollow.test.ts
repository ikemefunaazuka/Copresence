import { describe, expect, it } from 'vitest';

import { createScrollFollow } from './scrollFollow.js';

describe('createScrollFollow', () => {
  it('follows nobody initially', () => {
    const follow = createScrollFollow();
    expect(follow.isFollowing()).toBe(false);
    expect(follow.isFollowing('p1')).toBe(false);
  });

  it('enable() starts following the given participant', () => {
    const follow = createScrollFollow();
    follow.enable('p1');
    expect(follow.isFollowing()).toBe(true);
    expect(follow.isFollowing('p1')).toBe(true);
    expect(follow.isFollowing('p2')).toBe(false);
  });

  it('disable() stops following', () => {
    const follow = createScrollFollow();
    follow.enable('p1');
    follow.disable();
    expect(follow.isFollowing()).toBe(false);
  });

  it('a real (non-programmatic) scroll event releases follow — the local-intent break', () => {
    const follow = createScrollFollow();
    follow.enable('p1');
    follow.notifyScrollEvent();
    expect(follow.isFollowing()).toBe(false);
  });

  it('a scroll event during a programmatic scroll does not release follow', () => {
    const follow = createScrollFollow();
    follow.enable('p1');
    follow.beginProgrammaticScroll();
    follow.notifyScrollEvent(); // this is us scrolling to follow them, not local intent
    follow.endProgrammaticScroll();
    expect(follow.isFollowing('p1')).toBe(true);
  });

  it('a real scroll event right after a programmatic one still releases follow', () => {
    const follow = createScrollFollow();
    follow.enable('p1');
    follow.beginProgrammaticScroll();
    follow.endProgrammaticScroll();
    follow.notifyScrollEvent(); // genuinely the user, now that the flag is clear
    expect(follow.isFollowing()).toBe(false);
  });

  it('enabling follow for a new participant replaces who is being followed, not adds to it', () => {
    const follow = createScrollFollow();
    follow.enable('p1');
    follow.enable('p2');
    expect(follow.isFollowing('p1')).toBe(false);
    expect(follow.isFollowing('p2')).toBe(true);
  });
});
