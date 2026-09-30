import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useTranscriptScroll({ conversationId, hasContent, contentVersion, isVisible }: {
  conversationId: string | null;
  hasContent: boolean;
  contentVersion: unknown;
  isVisible: boolean;
}) {
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTranscriptRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const jumpToLatest = useCallback(() => {
    followTranscriptRef.current = true;
    const element = transcriptRef.current;
    if (element) element.scrollTop = hasContent ? element.scrollHeight : 0;
    setShowJumpToLatest(false);
  }, [hasContent]);

  useLayoutEffect(() => {
    followTranscriptRef.current = true;
    setShowJumpToLatest(false);
  }, [conversationId]);

  useLayoutEffect(() => {
    const element = transcriptRef.current;
    if (!element || !isVisible) return;
    const update = () => {
      if (!hasContent) {
        element.scrollTop = 0;
        followTranscriptRef.current = true;
        setShowJumpToLatest(false);
      } else if (followTranscriptRef.current) {
        element.scrollTop = element.scrollHeight;
        setShowJumpToLatest(false);
      } else {
        setShowJumpToLatest(element.scrollHeight - element.scrollTop - element.clientHeight > 96);
      }
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [conversationId, hasContent, contentVersion, isVisible]);

  const handleTranscriptScroll = useCallback(() => {
    const element = transcriptRef.current;
    if (!element || !hasContent) return;
    const nearEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 96;
    followTranscriptRef.current = nearEnd;
    setShowJumpToLatest(!nearEnd);
  }, [hasContent]);

  return { transcriptRef, followTranscriptRef, handleTranscriptScroll, showJumpToLatest, jumpToLatest };
}
