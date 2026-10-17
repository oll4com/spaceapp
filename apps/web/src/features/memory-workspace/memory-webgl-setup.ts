/** Keep context creation, shader setup and graph upload in separate browser tasks. */
export function queueMemoryWebGLSetup(steps: Array<() => void>, onError: () => void): () => void {
  let next = 0, cancelled = false;
  let timer: ReturnType<typeof setTimeout>;
  const cancel = () => { cancelled = true; clearTimeout(timer); };
  const schedule = () => {
    timer = setTimeout(() => {
      if (cancelled) return;
      try {
        steps[next++]?.();
        if (!cancelled && next < steps.length) schedule();
      } catch { cancel(); onError(); }
    }, 0);
  };
  schedule();
  return cancel;
}
