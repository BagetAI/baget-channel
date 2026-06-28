import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendBagetCommunityInvite } from './baget-telegram-bind.js';

describe('sendBagetCommunityInvite', () => {
  const KEY = 'COMMUNITY_TELEGRAM_URL';
  const original = process.env[KEY];
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it('skips (no send) when COMMUNITY_TELEGRAM_URL is unset', async () => {
    delete process.env[KEY];
    const fetchImpl = vi.fn();
    const res = await sendBagetCommunityInvite({
      botToken: 'BOT',
      chatId: 123,
      agentGroupId: 'ag-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips for a blank/whitespace url', async () => {
    process.env[KEY] = '   ';
    const fetchImpl = vi.fn();
    const res = await sendBagetCommunityInvite({
      botToken: 'BOT',
      chatId: 123,
      agentGroupId: 'ag-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: false, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the invite (with the url + brand line) when set', async () => {
    process.env[KEY] = 'https://t.me/+abc123';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    const res = await sendBagetCommunityInvite({
      botToken: 'BOT',
      chatId: 123,
      agentGroupId: 'ag-1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, messageId: '42' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/botBOT/sendMessage');
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe(123);
    expect(body.text).toContain('https://t.me/+abc123');
    expect(body.text).toContain('Baget founders community');
  });
});
