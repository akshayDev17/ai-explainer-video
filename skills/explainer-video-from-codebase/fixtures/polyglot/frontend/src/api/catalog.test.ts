import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { searchReviews, jobStatus } from './catalog';

vi.mock('axios');

describe('catalog api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  it('posts a review search', async () => {
    const r = await searchReviews('s', 'q');
    expect(r).toEqual({ ok: true });
  });

  it('reads a job status', async () => {
    await jobStatus('1');
    expect(axios.get).toHaveBeenCalledWith('/api/v1/ingest/jobs/1');
  });
});
