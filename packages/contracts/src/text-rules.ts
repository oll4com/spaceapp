import { z } from "zod";

/**
 * Business rule shared by the clipboard, task and shared chat texts: a text holds a non-whitespace character and at
 * most `maxCharacters` code points (ARCH-002). `noun` names it in the messages ("Clipboard text", "Shared chat text").
 */
export const nonBlankText = (noun: string, maxCharacters: number) =>
  z
    .string()
    .min(1)
    .refine((text) => Array.from(text).length <= maxCharacters, {
      message: `${noun} may contain at most ${maxCharacters} characters.`
    })
    .refine((text) => text.trim().length > 0, { message: `${noun} must contain a non-whitespace character.` });
