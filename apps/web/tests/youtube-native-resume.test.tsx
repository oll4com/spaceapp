import { installSpaceRuntime } from '../src/runtime/SpaceRuntime.js';
import { liveRuntime } from '../src/live/live-runtime.js';
import { setSpaceVolume } from '../src/space-audio.js';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane } from '@space/contracts';
import { YouTubePane } from '../src/features/browser-pane/YouTubePane.js';
import { YouTubeNativePlayer } from '../src/features/browser-pane/YouTubeNativePlayer.js';
import { parseYouTubePlayback, youtubePlaybackUrl } from '../src/features/browser-pane/youtube-playback.js';
import { USER_LINKS_UPDATED_EVENT } from '../src/features/user-links/UserLinks.js';

const mocks = vi.hoisted(() => ({ createLink: vi.fn(), links: vi.fn(), youtubeAccounts: vi.fn(), selectYouTubeAccount: vi.fn(), me: vi.fn(), youtubePlayback: vi.fn(), saveYouTubePlayback: vi.fn(), stopBrowserSession: vi.fn(), watchYouTube: vi.fn(), browserPages: vi.fn(), youtubeVideoText: vi.fn(), youtubeDownload: vi.fn(), youtubeDownloadJob: vi.fn(), userSettings: vi.fn(), updateUserSettings: vi.fn(), artifacts: vi.fn(), artifactFileUrl: vi.fn((id: string) => `/api/artifacts/${id}/file`), load: vi.fn() }));
vi.mock('../src/api.js', () => ({ api: mocks }));
vi.mock('../src/features/vibe-music/youtubePlaylistPlayer.js', () => ({ loadYouTubeIframeApi: mocks.load }));
vi.mock('../src/features/browser-pane/ManagedYouTubeBrowser.js', () => ({ ManagedYouTubeBrowser: ({ targetUrl }: { targetUrl?: string }) => <div data-testid="managed-youtube" data-target-url={targetUrl}>Managed browser</div> }));
const initial = { videoId: 'abcdefghijk', playlistId: null, index: 0, seconds: 125, title: 'Test', updatedAt: 100 };
let players: FakePlayer[] = [];
class FakePlayer {
  seconds = 125;
  videoId = 'abcdefghijk';
  title = 'Test';
  destroy = vi.fn();
  playVideo = vi.fn();
  pauseVideo = vi.fn();
  nextVideo = vi.fn(() => {
    if (this.playlist.length > 0) {
      this.playlistIndex = (this.playlistIndex + 1) % this.playlist.length;
      this.videoId = this.playlist[this.playlistIndex]!;
    }
  });
  previousVideo = vi.fn(() => {
    if (this.playlist.length > 0) {
      this.playlistIndex = (this.playlistIndex - 1 + this.playlist.length) % this.playlist.length;
      this.videoId = this.playlist[this.playlistIndex]!;
    }
  });
  playVideoAt = vi.fn((index: number) => {
    this.playlistIndex = index;
    if (this.playlist[index]) this.videoId = this.playlist[index]!;
  });
  seekTo = vi.fn((seconds: number) => { this.seconds = seconds; });
  getVideoData = () => ({ video_id: this.videoId, title: this.title });
  getCurrentTime = () => this.seconds;
  setLoop = vi.fn();
  setVolume = vi.fn();
  playlist = ['vid-1', 'vid-2', 'vid-3'];
  playlistIndex = 0;
  getPlaylist = () => this.playlist;
  getPlaylistIndex = () => this.playlistIndex;
  constructor(_stage: HTMLElement, readonly options: any) { players.push(this); }
}
const pane = { id: 'pane:test', roomId: 'room:test', title: 'YouTube', mode: 'YOUTUBE', isClosed: false, isMinimized: false } as Pane;
beforeEach(() => {
  installSpaceRuntime(liveRuntime);
  localStorage.clear(); sessionStorage.clear(); players = []; vi.clearAllMocks();
  mocks.links.mockResolvedValue({ data: [] });
  mocks.createLink.mockImplementation(async (input) => ({ id: 'link:new', ...input }));
  mocks.youtubeAccounts.mockResolvedValue({ selectedProfileId: null, profiles: [{ profileId: 'google-1', displayName: 'Google 1' }, { profileId: 'google-2', displayName: 'Google 2' }] });
  mocks.selectYouTubeAccount.mockResolvedValue({ selectedProfileId: 'google-2', targetUrl: 'https://accounts.google.com/ServiceLogin?service=youtube' });
  mocks.me.mockResolvedValue({ user: { id: 'user:one' } });
  mocks.youtubePlayback.mockResolvedValue({ playback: initial });
  mocks.saveYouTubePlayback.mockResolvedValue({ ok: true });
  mocks.stopBrowserSession.mockResolvedValue({ ok: true });
  mocks.load.mockResolvedValue({ Player: FakePlayer });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('YouTube native resume', () => {
  it('applies master volume to ready and new players without restarting playback', async () => {
    setSpaceVolume(0.62);
    const view = render(<YouTubeNativePlayer initial={initial} onProgress={vi.fn()} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    expect(players[0]!.setVolume).toHaveBeenLastCalledWith(62);
    act(() => setSpaceVolume(0));
    expect(players[0]!.setVolume).toHaveBeenLastCalledWith(0);
    expect(players).toHaveLength(1);
    expect(players[0]!.destroy).not.toHaveBeenCalled();
    expect(players[0]!.playVideo).not.toHaveBeenCalled();
    view.unmount();
    render(<YouTubeNativePlayer initial={initial} onProgress={vi.fn()} />);
    await waitFor(() => expect(players).toHaveLength(2));
    await act(async () => players[1]!.options.events.onReady());
    expect(players[1]!.setVolume).toHaveBeenLastCalledWith(0);
  });
  it('updates the title on ready and when autoplay changes videos without recreating the player', async () => {
    const onVideoTitleChange = vi.fn();
    render(<YouTubePane pane={pane} agentNumber={1} onVideoTitleChange={onVideoTitleChange} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    expect(onVideoTitleChange).toHaveBeenLastCalledWith('Test');
    players[0]!.videoId = 'lmnopqrstuv';
    players[0]!.title = 'Next video';
    await act(async () => players[0]!.options.events.onStateChange({ data: 1 }));
    expect(onVideoTitleChange).toHaveBeenLastCalledWith('Next video');
    expect(players).toHaveLength(1);
    expect(players[0]!.destroy).not.toHaveBeenCalled();
  });
  it('adds the video at click time, without playlist or progress parameters, and not the edited URL', async () => {
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    fireEvent.change(screen.getByRole('textbox', { name: 'YouTube video or playlist link' }), { target: { value: 'https://youtu.be/xxxxxxxxxxx' } });
    players[0]!.videoId = 'lmnopqrstuv';
    players[0]!.title = 'New autoplay video';
    fireEvent.click(screen.getByRole('button', { name: 'Add to Playlist' }));
    await waitFor(() => expect(mocks.createLink).toHaveBeenCalledWith({ title: 'New autoplay video', url: 'https://www.youtube.com/watch?v=lmnopqrstuv', description: '', category: 'MUSIC_LIBRARY', openMode: 'EMBEDDED', isQuick: false }));
    await act(async () => players[0]!.options.events.onStateChange({ data: 1 }));
    const added = await screen.findByRole('button', { name: 'Added to Playlist' });
    expect((added as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(added);
    expect(mocks.createLink).toHaveBeenCalledTimes(1);
  });
  it('shows an add failure and permits retry', async () => {
    mocks.createLink.mockRejectedValueOnce(new Error('Save failed'));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Playlist' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Save failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Add to Playlist' }));
    expect(await screen.findByRole('button', { name: 'Added to Playlist' })).toBeTruthy();
    expect(mocks.createLink).toHaveBeenCalledTimes(2);
  });
  it('summarizes the video playing now with AI, copies it and closes the summary', async () => {
    mocks.youtubeVideoText.mockResolvedValue({ text: 'A short talk.\n- 0:05 the point', model: 'gemini-3.8-flash-tiered' });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    players[0]!.videoId = 'lmnopqrstuv';
    players[0]!.title = 'Autoplayed talk';
    fireEvent.click(screen.getByRole('button', { name: 'Summarize with AI' }));
    const summary = await screen.findByRole('region', { name: 'AI summary' });
    expect(mocks.youtubeVideoText).toHaveBeenCalledWith('pane:test', 'lmnopqrstuv', 'summary');
    expect(summary.textContent).toContain('Autoplayed talk');
    expect(summary.textContent).toContain('- 0:05 the point');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'AI summary' })).toBeNull();
    mocks.youtubeVideoText.mockRejectedValueOnce(new Error('Gemini could not read the video: quota'));
    fireEvent.click(screen.getByRole('button', { name: 'Summarize with AI' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Gemini could not read the video: quota'));
  });
  it('gets the full text of the video and says it is working meanwhile', async () => {
    let answer: (value: unknown) => void = () => undefined;
    mocks.youtubeVideoText.mockImplementation(() => new Promise((done) => { answer = done; }));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Full text' }));
    expect(await screen.findByText(/Reading the video's captions/)).toHaveProperty('role', 'status');
    expect(screen.getByRole('button', { name: 'Summarize with AI' })).toHaveProperty('disabled', true);
    await act(async () => answer({ text: '0:00 Hello everyone.', model: 'gemini-3.8-flash-tiered' }));
    expect(mocks.youtubeVideoText).toHaveBeenCalledWith('pane:test', 'abcdefghijk', 'transcript');
    expect((await screen.findByRole('region', { name: 'Full text' })).textContent).toContain('0:00 Hello everyone.');
  });
  it('downloads the video playing now into Agent Files and the Video library and offers the file', async () => {
    const job = { id: 'vjob:one', paneId: 'pane:test', op: 'fetch', progress: 5, message: 'Downloading', result: null, error: null, createdAt: '2026-10-21T00:00:00.000Z', endedAt: null };
    mocks.youtubeDownload.mockResolvedValue({ job: { ...job, status: 'RUNNING' } });
    let finish: (value: unknown) => void = () => undefined;
    mocks.youtubeDownloadJob.mockImplementation(() => new Promise((done) => { finish = done; }));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    players[0]!.videoId = 'lmnopqrstuv';
    players[0]!.title = 'Oday Hacks';
    fireEvent.click(screen.getByRole('button', { name: 'Download video' }));
    expect(await screen.findByText(/Notifications tell you when it is done/)).toHaveProperty('role', 'status');
    expect(screen.getByRole('button', { name: 'Downloading video' })).toHaveProperty('disabled', true);
    expect(mocks.youtubeDownload).toHaveBeenCalledWith('pane:test', 'lmnopqrstuv', 'Oday Hacks');
    await act(async () => finish({ job: { ...job, status: 'DONE', result: { asset: { artifactId: 'artifact:abc123', width: 3840, height: 2160 }, folder: 'MEDIA/YouTube' } } }));
    const saved = await screen.findByRole('region', { name: 'Downloaded video' });
    expect(saved.textContent).toContain('Agent Files › Media / YouTube and the Video library · 3840×2160');
    expect(screen.getByRole('link', { name: 'Save file' }).getAttribute('href')).toBe('/api/artifacts/artifact:abc123/file');
    mocks.youtubeDownload.mockRejectedValueOnce(new Error('Video job vjob:two (assemble) is still running'));
    fireEvent.click(screen.getByRole('button', { name: 'Download video' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('still running'));
  });
  it('opens the pane settings: summary model, the Agent Files folder downloads go to and their resolution', async () => {
    mocks.userSettings.mockResolvedValue({ youtubeSummaryModel: 'gemini-3-flash', youtubeDownload: { folder: 'MEDIA/YouTube', maxHeight: 0 } });
    mocks.updateUserSettings.mockResolvedValue({});
    mocks.artifacts.mockResolvedValue({ data: [{ id: 'artifact:f1', metadata: { folder: 'Clips/Talks' } }], pagination: { totalPages: 1 } });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'YouTube settings' }));
    const panel = await screen.findByRole('region', { name: 'YouTube pane settings' });
    expect(panel.textContent).toContain('Download folder');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Clips / Talks' })).toBeTruthy());
    expect(screen.getByRole('option', { name: 'Media / YouTube' })).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Download folder' }), { target: { value: 'Clips/Talks' } });
    expect(mocks.updateUserSettings).toHaveBeenLastCalledWith({ youtubeDownload: { folder: 'Clips/Talks', maxHeight: 0 } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Download resolution' }), { target: { value: '1080' } });
    expect(mocks.updateUserSettings).toHaveBeenLastCalledWith({ youtubeDownload: { folder: 'Clips/Talks', maxHeight: 1080 } });
    mocks.updateUserSettings.mockRejectedValueOnce(new Error('Settings are read-only here'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Download resolution' }), { target: { value: '720' } });
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Settings are read-only here');
    expect((screen.getByRole('combobox', { name: 'Download resolution' }) as HTMLSelectElement).value).toBe('1080');
    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }));
    expect(screen.queryByRole('region', { name: 'YouTube pane settings' })).toBeNull();
  });
  it('shows in the toolbar only what applies now and never the Float of the titlebar', async () => {
    mocks.youtubePlayback.mockResolvedValue({ playback: null });
    mocks.browserPages.mockResolvedValue({ pages: [{ isActive: true, url: 'https://www.youtube.com/' }] });
    render(<YouTubePane pane={pane} agentNumber={1} onToggleFloat={vi.fn()} />);
    await screen.findByTestId('managed-youtube');
    for (const name of ['Summarize with AI', 'Full text', 'Download video', 'Add to Playlist', 'Play', 'Previous track', 'Next track', 'Play current video', 'Float mini player']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('combobox', { name: 'YouTube playlist' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'YouTube video or playlist link' }), { target: { value: 'https://youtu.be/xxxxxxxxxxx' } });
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });
  it('hides the button labels only while the toolbar does not fit them', async () => {
    const width = { scroll: 900, client: 600 };
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('youtube-toolbar') ? width.scroll : 0; });
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.classList.contains('youtube-toolbar') ? width.client : 0; });
    const view = render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    const toolbar = view.container.querySelector('.youtube-toolbar') as HTMLElement;
    await waitFor(() => expect(toolbar.dataset.compact).toBe('true'));
    width.client = 950;
    view.rerender(<YouTubePane pane={{ ...pane }} agentNumber={1} />);
    await waitFor(() => expect(toolbar.dataset.compact).toBeUndefined());
    scroll.mockRestore(); client.mockRestore();
  });
  it.each([true, false])('restores reload playback intent %s while preserving the saved time', async (wasPlaying) => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }] as unknown as PerformanceEntry[]);
    sessionStorage.setItem('test-playback:reload', JSON.stringify({ playing: wasPlaying, savedAt: Date.now() }));
    render(<YouTubeNativePlayer playbackKey="test-playback" initial={initial} onProgress={vi.fn()} />);
    await waitFor(() => expect(players).toHaveLength(1));
    const player = players[0]!;
    expect(player.options.playerVars).toMatchObject({ start: 125, autoplay: wasPlaying ? 1 : 0 });
    await act(async () => player.options.events.onReady());
    expect(player.playVideo).toHaveBeenCalledTimes(wasPlaying ? 1 : 0);
    if (!wasPlaying) {
      expect(player.pauseVideo).toHaveBeenCalled();
    }
    act(() => { player.options.events.onStateChange({ data: wasPlaying ? 1 : 2 }); window.dispatchEvent(new Event('pagehide')); });
    expect(JSON.parse(sessionStorage.getItem('test-playback:reload')!).playing).toBe(wasPlaying);
  });
  it('does not autoplay or trigger seek playback when opening pane with saved playback', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'navigate' }] as unknown as PerformanceEntry[]);
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    const player = players[0]!;
    expect(player.options.playerVars.autoplay).toBe(0);
    await act(async () => player.options.events.onReady());
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(player.pauseVideo).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });
  it('keeps video paused on refresh after user paused playback', async () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([{ type: 'reload' }] as unknown as PerformanceEntry[]);
    sessionStorage.setItem('space.youtube.playback.v1:user:one:pane:test:reload', JSON.stringify({ playing: false, savedAt: Date.now() }));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    const player = players[0]!;
    expect(player.options.playerVars.autoplay).toBe(0);
    await act(async () => player.options.events.onReady());
    expect(player.playVideo).not.toHaveBeenCalled();
    expect(player.pauseVideo).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Play' })).toBeTruthy();
  });
  it('restores saved time directly and releases the managed browser before starting the iframe', async () => {
    const view = render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    expect(mocks.stopBrowserSession).toHaveBeenCalledWith(pane.id);
    expect(players[0]!.options.playerVars).toMatchObject({ start: 125, controls: 1, autoplay: 0 });
    await act(async () => players[0]!.options.events.onReady());
    players[0]!.seconds = 187.5;
    view.unmount();
    await waitFor(() => expect(mocks.saveYouTubePlayback).toHaveBeenLastCalledWith(pane.id, expect.objectContaining({ seconds: 187.5 })));
    expect(players[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem('space.youtube.playback.v1:user:one:pane:test')!).seconds).toBe(187.5);
  });
  it('keeps playing when minimized instead of releasing the iframe', async () => {
    const progress = vi.fn();
    const view = render(<YouTubeNativePlayer initial={initial} onProgress={progress} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    players[0]!.seconds = 201;
    // Minimizing the pane keeps the same player mounted so audio continues.
    view.rerender(<YouTubeNativePlayer initial={initial} onProgress={progress} />);
    expect(players[0]!.destroy).not.toHaveBeenCalled();
    expect(players).toHaveLength(1);
  });
  it('keeps the YouTubePane player mounted when the pane is minimized', async () => {
    const view = render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    view.rerender(<YouTubePane pane={{ ...pane, isMinimized: true }} agentNumber={1} />);
    expect(players).toHaveLength(1);
    expect(players[0]!.destroy).not.toHaveBeenCalled();
  });
  it('does not start a late iframe after the pane closes', async () => {
    let resolve: (value: unknown) => void = () => undefined;
    mocks.load.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const view = render(<YouTubeNativePlayer initial={initial} onProgress={vi.fn()} />);
    view.unmount();
    await act(async () => resolve({ Player: FakePlayer }));
    expect(players).toHaveLength(0);
  });
  it('moves a video opened in the YouTube browser to the player at the captured time, and Browse YouTube does not bounce back', async () => {
    mocks.youtubePlayback.mockResolvedValue({ playback: null });
    mocks.browserPages.mockResolvedValue({ pages: [{ isActive: true, url: 'https://www.youtube.com/watch?v=abcdefghijk' }] });
    mocks.watchYouTube.mockResolvedValue({ currentUrl: 'https://www.youtube.com/watch?v=abcdefghijk&t=81s' });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1), { timeout: 4000 });
    expect(players[0]!.options.playerVars.start).toBe(81);
    expect(players[0]!.options.playerVars.autoplay).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Browse YouTube' }));
    await screen.findByTestId('managed-youtube');
    await new Promise((done) => setTimeout(done, 1800));
    expect(mocks.watchYouTube).toHaveBeenCalledTimes(1);
    mocks.browserPages.mockResolvedValue({ pages: [{ isActive: true, url: 'https://www.youtube.com/watch?v=zyxwvutsrqp' }] });
    mocks.watchYouTube.mockResolvedValue({ currentUrl: 'https://www.youtube.com/watch?v=zyxwvutsrqp' });
    await waitFor(() => expect(mocks.watchYouTube).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await waitFor(() => expect(screen.queryByTestId('managed-youtube')).toBeNull());
  }, 15000);
  it('does not start playback if releasing the remote browser fails', async () => {
    mocks.stopBrowserSession.mockRejectedValue(new Error('offline'));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await screen.findByRole('alert');
    expect(players).toHaveLength(0);
  });
  it('isolates local progress by authenticated user and preserves a later offline checkpoint', async () => {
    localStorage.setItem('space.youtube.playback.v1:user:other:pane:test', JSON.stringify({ ...initial, seconds: 888, updatedAt: 300 }));
    localStorage.setItem('space.youtube.playback.v1:user:one:pane:test', JSON.stringify({ ...initial, seconds: 222, updatedAt: 200 }));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    expect(players[0]!.options.playerVars.start).toBe(222);
  });
});
describe('YouTube playback links', () => {
  it('preserves video, playlist, index and time without accepting lookalike hosts', () => {
    const value = parseYouTubePlayback('https://www.youtube.com/watch?v=abcdefghijk&list=PL1234567890&index=3&t=1h2m3s')!;
    expect(value).toMatchObject({ seconds: 3723, index: 2, playlistId: 'PL1234567890' });
    expect(parseYouTubePlayback(youtubePlaybackUrl(value))).toMatchObject({ seconds: 3723, index: 2 });
    expect(parseYouTubePlayback('https://youtube.com.evil.test/watch?v=abcdefghijk')).toBeNull();
    expect(parseYouTubePlayback('https://www.youtube.com/playlist?list=PL1234567890')).toMatchObject({ videoId: '', playlistId: 'PL1234567890' });
  });
});

describe('YouTube Google account picker', () => {
  it('renders the account menu outside the clipped toolbar and restores focus with Escape', async () => {
    render(<YouTubePane pane={pane} agentNumber={1} />);
    const button = await screen.findByRole('button', { name: 'Google account for YouTube' });
    fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'YouTube Google accounts' });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.closest('.youtube-toolbar')).toBeNull();
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'YouTube Google accounts' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });
  it('dismisses the account menu on outside clicks', async () => {
    render(<YouTubePane pane={pane} agentNumber={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Google account for YouTube' }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu', { name: 'YouTube Google accounts' })).toBeNull();
  });
  it('hides and restores the whole toolbar without recreating the playing iframe', async () => {
    const view = render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    await act(async () => players[0]!.options.events.onReady());
    fireEvent.click(screen.getByRole('button', { name: 'Google account for YouTube' }));
    view.rerender(<YouTubePane pane={pane} agentNumber={1} toolbarHidden />);
    expect(view.container.querySelector('.youtube-toolbar')).toBeNull();
    expect(screen.queryByRole('menu', { name: 'YouTube Google accounts' })).toBeNull();
    expect(players[0]!.destroy).not.toHaveBeenCalled();
    view.rerender(<YouTubePane pane={pane} agentNumber={1} />);
    expect(screen.getByRole('button', { name: 'Google account for YouTube' })).toBeTruthy();
    expect(players).toHaveLength(1);
    expect(players[0]!.destroy).not.toHaveBeenCalled();
  });
  it('selects a named account, stops native playback and opens its Google sign-in', async () => {
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Google account for YouTube' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Google 2' }));
    await waitFor(() => expect(mocks.selectYouTubeAccount).toHaveBeenCalledWith('pane:test', 'google-2'));
    expect((await screen.findByTestId('managed-youtube')).getAttribute('data-target-url')).toBe('https://accounts.google.com/ServiceLogin?service=youtube');
    expect(players[0]!.destroy).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Google account for YouTube' }).getAttribute('title')).toBe('Browser account: Google 2');
  });
  it('reconnects the selected account in its saved YouTube browser profile with its sign-in hint', async () => {
    const signIn = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F&Email=verified%40example.test';
    mocks.youtubeAccounts.mockResolvedValue({ selectedProfileId: 'google_account:verified', profiles: [{ profileId: 'google_account:verified', displayName: 'Verified', browserStatus: 'REAUTHENTICATION_REQUIRED' }] });
    mocks.selectYouTubeAccount.mockResolvedValue({ selectedProfileId: 'google_account:verified', targetUrl: signIn });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Google account for YouTube' }));
    expect(screen.getByRole('menuitemradio', { name: 'Verified · Sign in again · Linked Google account' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Sign in to selected account' }).className).toContain('attention');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign in to selected account' }));
    await waitFor(() => expect(mocks.selectYouTubeAccount).toHaveBeenCalledWith('pane:test', 'google_account:verified', { signIn: true }));
    expect((await screen.findByTestId('managed-youtube')).getAttribute('data-target-url')).toBe(signIn);
  });
  it('opens the shared primary account by default instead of a pane-only profile', async () => {
    mocks.youtubeAccounts.mockResolvedValue({ selectedProfileId: null, effectiveProfileId: 'google_account:primary', profiles: [{ profileId: 'google_account:primary', displayName: 'Primary', browserStatus: 'CONNECTED' }] });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    const trigger = await screen.findByRole('button', { name: 'Google account for YouTube' });
    await waitFor(() => expect(trigger.getAttribute('title')).toBe('Browser account: Primary · Signed in'));
    expect(trigger.getAttribute('data-account-status')).toBe('ok');
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitemradio', { name: 'Primary · Signed in · Linked Google account' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitemradio', { name: 'Private pane profile' }).getAttribute('aria-checked')).toBe('false');
  });
  it('falls back to a plain YouTube sign-in when an older server returns the home page', async () => {
    mocks.youtubeAccounts.mockResolvedValue({ selectedProfileId: 'google_account:verified', profiles: [{ profileId: 'google_account:verified', displayName: 'Verified' }] });
    mocks.selectYouTubeAccount.mockResolvedValue({ selectedProfileId: 'google_account:verified', targetUrl: 'https://www.youtube.com/' });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Google account for YouTube' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign in to selected account' }));
    expect((await screen.findByTestId('managed-youtube')).getAttribute('data-target-url')).toMatch(/^https:\/\/accounts\.google\.com\/ServiceLogin\?service=youtube/);
  });
  it('restores the saved selection and retains it when an account change fails', async () => {
    mocks.youtubeAccounts.mockResolvedValue({ selectedProfileId: 'google-2', profiles: [{ profileId: 'google-1', displayName: 'Google 1' }, { profileId: 'google-2', displayName: 'Google 2' }] });
    mocks.selectYouTubeAccount.mockRejectedValue(new Error('Browser control is held by another operator.'));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Google account for YouTube' }));
    expect(screen.getByRole('menuitemradio', { name: 'Google 2' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Google 1' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Browser control is held');
    expect(screen.getByRole('button', { name: 'Google account for YouTube' }).getAttribute('title')).toBe('Browser account: Google 2');
  });
  it('does not let an observer switch Google accounts', () => {
    render(<YouTubePane pane={pane} agentNumber={1} observerOnly />);
    expect(screen.queryByRole('button', { name: 'Google account for YouTube' })).toBeNull();
    expect(mocks.youtubeAccounts).not.toHaveBeenCalled();
  });
});

describe('YouTube playlist picker', () => {
  it('loads saved playlists and starts playing the selected playlist', async () => {
    mocks.links.mockResolvedValue({
      data: [
        { id: 'link:work', title: 'Work Music', url: 'https://www.youtube.com/playlist?list=PL12345678', category: 'MUSIC_LIBRARY' },
        { id: 'link:other', title: 'Ignored', url: 'https://example.com', category: 'DEV' }
      ]
    });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));

    const select = await screen.findByRole('combobox', { name: 'YouTube playlist' });
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
    expect(select.textContent).toContain('Work Music');

    await act(async () => {
      fireEvent.change(select, { target: { value: 'link:work' } });
    });

    await waitFor(() => {
      expect(mocks.stopBrowserSession).toHaveBeenCalled();
      expect(mocks.saveYouTubePlayback).toHaveBeenCalledWith(pane.id, expect.objectContaining({
        playlistId: 'PL12345678'
      }));
      expect(players).toHaveLength(2);
    });
    expect((screen.getByRole('textbox', { name: 'YouTube video or playlist link' }) as HTMLInputElement).value).toBe('https://www.youtube.com/playlist?list=PL12345678');
    expect(players[1]!.options.playerVars.autoplay).toBe(1);
    await act(async () => players[1]!.options.events.onReady());
    expect(players[1]!.playVideo).toHaveBeenCalledTimes(1);
  });

  it('refreshes playlists when user links updated event fires', async () => {
    mocks.links.mockResolvedValue({ data: [] });
  mocks.createLink.mockImplementation(async (input) => ({ id: 'link:new', ...input }));
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));

    expect(screen.queryByRole('combobox', { name: 'YouTube playlist' })).toBeNull();

    mocks.links.mockResolvedValue({
      data: [
        { id: 'link:study', title: 'Study Beats', url: 'https://www.youtube.com/playlist?list=PL98765432', category: 'MUSIC_LIBRARY' }
      ]
    });

    await act(async () => {
      window.dispatchEvent(new Event(USER_LINKS_UPDATED_EVENT));
    });

    expect((await screen.findByRole('combobox', { name: 'YouTube playlist' })).textContent).toContain('Study Beats');
  });

  it('toggles play and pause on the active player and updates button label', async () => {
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    const player = players[0]!;
    await act(async () => player.options.events.onReady());

    // Initially not playing, button shows Play
    const playBtn = screen.getByRole('button', { name: 'Play' });
    expect(playBtn).toBeDefined();

    // Click Play -> starts playback
    await act(async () => {
      fireEvent.click(playBtn);
    });
    expect(player.playVideo).toHaveBeenCalled();

    // Player notifies state change to playing (1)
    await act(async () => {
      player.options.events.onStateChange({ data: 1 });
    });

    // Button updates to Pause
    const pauseBtn = await screen.findByRole('button', { name: 'Pause' });
    expect(pauseBtn).toBeDefined();

    // Click Pause -> pauses playback
    await act(async () => {
      fireEvent.click(pauseBtn);
    });
    expect(player.pauseVideo).toHaveBeenCalled();

    // Player notifies state change to paused (2)
    await act(async () => {
      player.options.events.onStateChange({ data: 2 });
    });
    expect(await screen.findByRole('button', { name: 'Play' })).toBeDefined();
  });

  it('navigates previous and next track in playlist and loops around at boundaries', async () => {
    // initial playback with playlist
    mocks.youtubePlayback.mockResolvedValue({
      playback: { ...initial, playlistId: 'PL_TEST_LIST' }
    });
    render(<YouTubePane pane={pane} agentNumber={1} />);
    await waitFor(() => expect(players).toHaveLength(1));
    const player = players[0]!;
    player.playlist = ['track-1', 'track-2', 'track-3'];
    player.playlistIndex = 0;
    await act(async () => player.options.events.onReady());

    const prevBtn = screen.getByRole('button', { name: 'Previous track' });
    const nextBtn = screen.getByRole('button', { name: 'Next track' });

    // At track 0, clicking previous loops to the last track (index 2)
    await act(async () => {
      fireEvent.click(prevBtn);
    });
    expect(player.playVideoAt).toHaveBeenCalledWith(2);

    // At track 2 (last track), clicking next loops around to track 0
    player.playlistIndex = 2;
    await act(async () => {
      fireEvent.click(nextBtn);
    });
    expect(player.playVideoAt).toHaveBeenCalledWith(0);

    // At track 1, clicking next calls nextVideo
    player.playlistIndex = 1;
    await act(async () => {
      fireEvent.click(nextBtn);
    });
    expect(player.nextVideo).toHaveBeenCalled();

    // When last video ends (state 0), it automatically loops back to track 0
    player.playlistIndex = 2;
    await act(async () => {
      player.options.events.onStateChange({ data: 0 });
    });
    expect(player.playVideoAt).toHaveBeenCalledWith(0);
  });
});





it('does not enqueue identical playback saves every second while paused', async () => {
  const progress = vi.fn();
  const view = render(<YouTubeNativePlayer initial={initial} onProgress={progress} />);
  await waitFor(() => expect(players).toHaveLength(1));
  vi.useFakeTimers();
  try {
    await act(async () => players[0]!.options.events.onReady());
    expect(progress).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(progress).toHaveBeenCalledTimes(1);
    players[0]!.seconds = 140;
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ seconds: 140 }));
  } finally { view.unmount(); vi.useRealTimers(); }
});
