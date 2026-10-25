import { describe, expect, it, vi } from "vitest";
import {
  convertGreekToQwerty,
  convertQwertyToGreek,
  convertTextRange,
  createGreekInputState,
  detectKeyboardLayoutMismatch,
  enterAddsLine,
  handleEnglishKeyInput,
  handleGreekKeyInput,
  isRecognizedGreekLayout,
  scoreGreekMismatch,
  smartTransliterateWord,
  toggleKeyboardLayout
} from "../src/features/agent-pane/greek-layout-converter.js";

describe("greek-layout-converter", () => {
  describe("spelling and language safety", () => {
    it.each(["keayboard", "keybaord", "keybord", "keyboarf"])("suggests keyboard for %s", (input) => {
      expect(detectKeyboardLayoutMismatch(input)).toMatchObject({ hasMismatch: true, convertedText: "keyboard" });
      expect(toggleKeyboardLayout(input)).toBe("keyboard");
    });

    it.each(["keyboard", "keayboard", "keybaord"])("keeps %s English in the screenshot sentence", (word) => {
      const input = `mporei na periexei kai oruografo oste na mhn ginontai allages kai se keimena poy den prepei -- ${word}`;
      const result = detectKeyboardLayoutMismatch(input);
      expect(result.hasMismatch).toBe(true);
      expect(result.convertedText).toBe("μπορεί να περιέχει και ορθογράφο ώστε να μην γίνονται αλλαγές και σε κείμενα που δεν πρέπει -- keyboard");
      expect(toggleKeyboardLayout(input)).toBe(result.convertedText);
    });

    it("corrects English spelling beside recognized Greeklish", () => {
      expect(toggleKeyboardLayout("veltiose mou to keayboard")).toBe("βελτίωσε μου το keyboard");
      expect(toggleKeyboardLayout("το keayboard δουλεύει")).toBe("το keyboard δουλεύει");
      expect(toggleKeyboardLayout("Keayboard")).toBe("Keyboard");
    });

    it.each([
      "το keyboard δουλεύει", "μπορεί να περιέχει keyboard", "κάνε ένα τεστ", "μια δοκιμή τεστ",
      "keyboard", "literature", "sever", "foobarquux", "το foobarquux δουλεύει",
      "`keayboard`", "/keayboard", "keayboard.ts", "https://example.com/keayboard", "user@keayboard.com",
      "keyBoard", "KEAYBOARD", "const keayboard = true"
    ])("does not propose changes to %s", (input) => {
      expect(detectKeyboardLayoutMismatch(input).hasMismatch).toBe(false);
    });

    it("preserves unknown words and literals even in a detected Greek sentence", () => {
      const literals = "foobarquux literature /keayboard `keayboard` keyBoard";
      expect(toggleKeyboardLayout(`kane restart sto ${literals}`)).toBe(`κανε restart στο ${literals}`);
      expect(toggleKeyboardLayout(`l;auow sto ${literals}`)).toBe(`λάθος στο ${literals}`);
    });

    it("preserves ambiguity instead of picking one dictionary neighbour", () => {
      // Both service and services are one edit away.
      expect(toggleKeyboardLayout("servics")).toBe("servics");
    });

    it.each(["give it to me", "const keayboard = true", "το keyboard δουλεύει", "το foobarquux δουλεύει", "`keayboard`"])("does not force a change via Alt+G for %s", (input) => {
      expect(toggleKeyboardLayout(input)).toBe(input);
    });
  });
  describe("Greeklish suggestions", () => {
    it.each([
      ["beltivse moy to ergaleio ayto", "βελτίωσε μου το εργαλείο αυτό"],
      ["Veltiose mou to ergaleio auto", "Βελτίωσε μου το εργαλείο αυτό"],
      ["thelo na doume ti kanei to server", "θέλω να δούμε τι κάνει το server"],
      ["διόρθωσε το και veltiose mou to UI", "διόρθωσε το και βελτίωσε μου το UI"],
      ["beltivse moy /model", "βελτίωσε μου /model"],
      ["veltiose\n  mou to ergaleio!", "βελτίωσε\n  μου το εργαλείο!"],
    ])("converts %s consistently for preview and shortcut", (input, expected) => {
      expect(detectKeyboardLayoutMismatch(input)).toMatchObject({ hasMismatch: true, convertedText: expected });
      expect(toggleKeyboardLayout(input)).toBe(expected);
    });

    it("preserves literals, technical identifiers and unfamiliar names", () => {
      const literals = "`thelo mou` https://example.com?q=thelo;auto a@ergaleio.com /opt/spaceapp paneId MCP package.json Zorblax";
      const input = `veltiose mou ${literals}`;
      expect(detectKeyboardLayoutMismatch(input).convertedText).toBe(`βελτίωσε μου ${literals}`);
    });

    it.each([
      "show me how to use the tool", "The model works for me", "auto update", "Boris", "/model", "MCP API CLI",
      "https://example.com?q=thelo;auto", "`thelo mou`", "```js\nconst thelo = 'mou';\n```",
      "const thelo = { value: 'mou' }", "const x = foo:input", "user@ergaleio.com"
    ])("does not suggest a correction for %s", (input) => {
      expect(detectKeyboardLayoutMismatch(input).hasMismatch).toBe(false);
    });

    it("keeps code intact beside a keyboard-layout correction", () => {
      expect(detectKeyboardLayoutMismatch("l;auow `const a = 1` /model").convertedText)
        .toBe("λάθος `const a = 1` /model");
    });

    it("converts a selection and keeps the caret at the end after contraction", () => {
      const input = "thelo mou";
      expect(convertTextRange(input, input.length, input.length)).toEqual({
        newText: "θέλω μου", newStart: 8, newEnd: 8
      });
      const text = `Please ${input} here`;
      expect(convertTextRange(text, 7, 7 + input.length)).toEqual({
        newText: "Please θέλω μου here", newStart: 7, newEnd: 15
      });
    });
  });
  describe("convertQwertyToGreek", () => {
    it("converts 'l;auow' directly to 'λάθος'", () => {
      expect(convertQwertyToGreek("l;auow")).toBe("λάθος");
    });

    it("converts dead key tonos with various vowels", () => {
      expect(convertQwertyToGreek("kallhm;era")).toBe("καλλημέρα");
      expect(convertQwertyToGreek("ti k;aneiwq")).toBe("τι κάνεις;");
      expect(convertQwertyToGreek("pr;oblhma")).toBe("πρόβλημα");
      expect(convertQwertyToGreek("d;wse moy")).toBe("δώσε μου");
      expect(convertQwertyToGreek(";ola kal;a")).toBe("όλα καλά");
    });

    it("converts dialytika and combined dialytika + tonos", () => {
      expect(convertQwertyToGreek("ma:i")).toBe("μαϊ");
      expect(convertQwertyToGreek("prv:i")).toBe("πρωϊ");
      expect(convertQwertyToGreek("ma;:i")).toBe("μαΐ");
    });

    it("properly handles word-final sigma (ς)", () => {
      expect(convertQwertyToGreek("kalos")).toBe("καλος");
      expect(convertQwertyToGreek("o anurvpos")).toBe("ο ανθρωπος");
      expect(convertQwertyToGreek("aytos o kosmos")).toBe("αυτος ο κοσμος");
    });

    it("handles uppercase letters with tonos", () => {
      expect(convertQwertyToGreek(";Ellada")).toBe("Έλλαδα");
      expect(convertQwertyToGreek(";Omorfh")).toBe("Όμορφη");
    });

    it("preserves English technical terms like 'mcp' and 'control' untouched", () => {
      expect(convertQwertyToGreek("mcp control")).toBe("mcp control");
      expect(convertQwertyToGreek("docker run -it ubuntu")).toBe("docker run -it ubuntu");
      expect(convertQwertyToGreek("git status")).toBe("git status");
    });

    it("converts Greek QWERTY mistypes while preserving English terms in the same text", () => {
      expect(convertQwertyToGreek("l;auow sto mcp control")).toBe("λάθος στο mcp control");
      expect(convertQwertyToGreek("git status ston server")).toBe("git status στον server");
      expect(convertQwertyToGreek("kane restart sto service")).toBe("κανε restart στο service");
      expect(convertQwertyToGreek("kan eelegxo to spaceapp gia problhmata kai melti;vseiw")).toBe("καν εελεγχο το spaceapp για προβληματα και μελτιώσεις");
    });

    it("preserves code identifiers, camelCase, filenames and file paths untouched", () => {
      expect(convertQwertyToGreek("apps/web/package.json")).toBe("apps/web/package.json");
      expect(convertQwertyToGreek("const paneId = roomId")).toBe("const paneId = roomId");
      expect(convertQwertyToGreek("space-web docker-compose.yml")).toBe("space-web docker-compose.yml");
    });
  });

  describe("convertGreekToQwerty", () => {
    it("converts Greek letters back to QWERTY", () => {
      expect(convertGreekToQwerty("τηε")).toBe("the");
      expect(convertGreekToQwerty("ηελλο")).toBe("hello");
      expect(convertGreekToQwerty("γιτ στατυς")).toBe("git statys");
      expect(convertGreekToQwerty("δοψκερ")).toBe("docker");
      expect(convertGreekToQwerty("τηις ις α τεστ")).toBe("this is a test");
    });

    it("converts Greek-typed 'μψπ ψοντρολ' back to 'mcp control'", () => {
      expect(convertGreekToQwerty("μψπ ψοντρολ")).toBe("mcp control");
    });
  });

  describe("detectKeyboardLayoutMismatch", () => {
    it("detects 'l;auow' as Greek typed with QWERTY layout with high confidence", () => {
      const detection = detectKeyboardLayoutMismatch("l;auow");
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toGreek");
      expect(detection.convertedText).toBe("λάθος");
      expect(detection.confidence).toBeGreaterThan(0.9);
    });

    it("detects Greek question mark and final sigma endings", () => {
      const detection = detectKeyboardLayoutMismatch("ti kaneiwq");
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toGreek");
      expect(detection.convertedText).toBe("τι κανεις;");
    });

    it("does not false-positive on English words ending in 'w'", () => {
      expect(detectKeyboardLayoutMismatch("show new window").hasMismatch).toBe(false);
      expect(detectKeyboardLayoutMismatch("view workflow").hasMismatch).toBe(false);
    });

    it("detects English keywords typed with Greek layout", () => {
      const detection = detectKeyboardLayoutMismatch("γιτ στατυς");
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toQwerty");
      expect(detection.convertedText).toBe("git statys");
    });

    it("detects 'μψπ ψοντρολ' typed with Greek layout and suggests 'mcp control'", () => {
      const detection = detectKeyboardLayoutMismatch("μψπ ψοντρολ");
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toQwerty");
      expect(detection.convertedText).toBe("mcp control");
      expect(detection.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("detects 'δοψκερ ρθν' typed with Greek layout and suggests 'docker run'", () => {
      const detection = detectKeyboardLayoutMismatch("δοψκερ ρθν");
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toQwerty");
      expect(detection.convertedText).toBe("docker run");
    });

    it("returns negative for normal English text without dead keys", () => {
      const detection = detectKeyboardLayoutMismatch("hello world from server");
      expect(detection.hasMismatch).toBe(false);
    });

    it("returns negative for Greek sentences containing preserved English terms", () => {
      const detection = detectKeyboardLayoutMismatch("θελω να δουμε το mcp control");
      expect(detection.hasMismatch).toBe(false);
    });

    it("detects natural Greek sentences typed on QWERTY layout without dead keys", () => {
      const input = "gia na doyme pvw ua doylecei kai ti prepei na kanoyme";
      const detection = detectKeyboardLayoutMismatch(input);
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toGreek");
      expect(detection.convertedText).toBe("για να δουμε πως θα δουλεψει και τι πρεπει να κανουμε");
    });

    it("detects mixed Greek/Latin input where Latin words are Greek layout mistypes while preserving English terms", () => {
      const input = "κανουμε μια δοκιμη gia na doyme pvw ua doylecei kai ti prepei na kanoyme sto mcp control";
      const detection = detectKeyboardLayoutMismatch(input);
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toGreek");
      expect(detection.convertedText).toBe("κανουμε μια δοκιμη για να δουμε πως θα δουλεψει και τι πρεπει να κανουμε στο mcp control");
    });

    it("detects mixed input with newly appended Latin words after initial correction", () => {
      const input = "οκ βλεπω να δουλευει τωρα νομιζω οτι ειναι σωστα - -- enhmervste thn mnhmh";
      const detection = detectKeyboardLayoutMismatch(input);
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toGreek");
      expect(detection.convertedText).toBe("οκ βλεπω να δουλευει τωρα νομιζω οτι ειναι σωστα - -- ενημερωστε την μνημη");
      expect(detection.confidence).toBeGreaterThanOrEqual(0.85);
    });

    it("detects multiple sequential edits when user adds more Latin words", () => {
      const input = "οκ βλεπω να δουλευει τωρα νομιζω οτι ειναι σωστα - -- ενημερωστε την μνημη - kai allo keimeno";
      const detection = detectKeyboardLayoutMismatch(input);
      expect(detection.hasMismatch).toBe(true);
      expect(detection.direction).toBe("toGreek");
      expect(detection.convertedText).toBe("οκ βλεπω να δουλευει τωρα νομιζω οτι ειναι σωστα - -- ενημερωστε την μνημη - και αλλο κειμενο");
    });
  });

  describe("toggleKeyboardLayout", () => {
    it("toggles between QWERTY and Greek", () => {
      expect(toggleKeyboardLayout("l;auow")).toBe("λάθος");
      expect(toggleKeyboardLayout("λάθος")).toBe("lauos");
    });

    it("converts Latin parts to Greek when input contains mixed Greek and Latin", () => {
      const mixed = "οκ βλεπω να δουλευει τωρα νομιζω οτι ειναι σωστα - -- enhmervste thn mnhmh";
      expect(toggleKeyboardLayout(mixed)).toBe("οκ βλεπω να δουλευει τωρα νομιζω οτι ειναι σωστα - -- ενημερωστε την μνημη");
    });

    it("preserves mixed prose when English keywords are already correct", () => {
      const mixed = "θελω να δουμε το mcp control";
      expect(toggleKeyboardLayout(mixed)).toBe(mixed);
    });

    it("toggles 'μψπ ψοντρολ' back to 'mcp control'", () => {
      expect(toggleKeyboardLayout("μψπ ψοντρολ")).toBe("mcp control");
    });
  });

  describe("convertTextRange", () => {
    it("converts only selected range when selection is specified", () => {
      const text = "Please fix l;auow here";
      const start = text.indexOf("l;auow");
      const end = start + "l;auow".length;
      const result = convertTextRange(text, start, end, "toGreek");
      expect(result.newText).toBe("Please fix λάθος here");
    });
  });

  describe("handleGreekKeyInput live typing", () => {
    it("maps Latin keys to Greek characters when Greek mode is active", () => {
      const state = createGreekInputState(true);
      let output = "";
      const onInsert = (char: string) => { output += char; };

      for (const key of ["k", "a", "l", "h", "m", "e", "r", "a"]) {
        const handled = handleGreekKeyInput({ key, ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
        expect(handled).toBe(true);
      }
      expect(output).toBe("καλημερα");
    });

    it("handles tonos dead key ';' with vowels", () => {
      const state = createGreekInputState(true);
      let output = "";
      const onInsert = (char: string) => { output += char; };

      // Typing ';v' -> 'ώ'
      handleGreekKeyInput({ key: ";", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      handleGreekKeyInput({ key: "v", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      // Typing ';a' -> 'ά'
      handleGreekKeyInput({ key: ";", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      handleGreekKeyInput({ key: "a", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);

      expect(output).toBe("ώά");
    });

    it("handles dialytika dead key ':' with i and y", () => {
      const state = createGreekInputState(true);
      let output = "";
      const onInsert = (char: string) => { output += char; };

      handleGreekKeyInput({ key: ":", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      handleGreekKeyInput({ key: "i", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      expect(output).toBe("ϊ");
    });

    it("handles double semicolon ';;' by inserting ';'", () => {
      const state = createGreekInputState(true);
      let output = "";
      const onInsert = (char: string) => { output += char; };

      handleGreekKeyInput({ key: ";", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      handleGreekKeyInput({ key: ";", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      expect(output).toBe(";");
    });

    it("does not intercept when already native Greek character", () => {
      const state = createGreekInputState(true);
      let output = "";
      const onInsert = (char: string) => { output += char; };

      const handled = handleGreekKeyInput({ key: "α", ctrlKey: false, altKey: false, metaKey: false }, state, onInsert);
      expect(handled).toBe(false);
      expect(output).toBe("");
    });

    it("ignores modifier keys so shortcuts work normally", () => {
      const state = createGreekInputState(true);
      let output = "";
      const onInsert = (char: string) => { output += char; };

      const handled = handleGreekKeyInput({ key: "c", ctrlKey: true, altKey: false, metaKey: false }, state, onInsert);
      expect(handled).toBe(false);
      expect(output).toBe("");
    });
  });

  describe("user screenshot scenarios", () => {
    it("converts all Greek words including problhmata without leaving English words behind", () => {
      const input = "καν εελεγχο το spaceapp gia problhmata kai melti;vseiw";
      const result = detectKeyboardLayoutMismatch(input);
      expect(result.hasMismatch).toBe(true);
      expect(result.convertedText).toBe("καν εελεγχο το spaceapp για προβληματα και μελτιώσεις");
      expect(toggleKeyboardLayout(input)).toBe("καν εελεγχο το spaceapp για προβληματα και μελτιώσεις");
    });

    it("converts mixed Greek and Greeklish while preserving English keywords like max", () => {
      const input = "οχι δεν pethxe γιατι δεν υπαρχει επιλογή max εκει arxizoun ολα ";
      const result = detectKeyboardLayoutMismatch(input);
      expect(result.hasMismatch).toBe(true);
      expect(result.convertedText).toBe("οχι δεν πέτυχε γιατι δεν υπαρχει επιλογή max εκει αρχίζουν ολα ");
      expect(toggleKeyboardLayout(input)).toBe("οχι δεν πέτυχε γιατι δεν υπαρχει επιλογή max εκει αρχίζουν ολα ");
    });

    it("records structured debug tokens and exposes debug inspection API", () => {
      const input = "οχι δεν pethxe γιατι δεν υπαρχει επιλογή max εκει arxizoun ολα ";
      const debugApi = (globalThis as any).window?.__SPACE_GREEK_LAYOUT_DEBUG__;
      expect(debugApi).toBeDefined();

      const inspected = debugApi.inspect(input);
      expect(inspected.detection.hasMismatch).toBe(true);
      expect(inspected.lastReport).toBeDefined();
      expect(inspected.lastReport.tokens.length).toBeGreaterThanOrEqual(3);

      const pethxeToken = inspected.lastReport.tokens.find((t: any) => t.token === "pethxe");
      expect(pethxeToken).toBeDefined();
      expect(pethxeToken.action).toBe("CONVERT_QWERTY");
      expect(pethxeToken.result).toBe("πετηχε");

      const maxToken = inspected.lastReport.tokens.find((t: any) => t.token === "max");
      expect(maxToken).toBeDefined();
      expect(maxToken.action).toBe("PRESERVE_ENGLISH");
      expect(maxToken.result).toBe("max");

      const arxizounToken = inspected.lastReport.tokens.find((t: any) => t.token === "arxizoun");
      expect(arxizounToken).toBeDefined();
      expect(arxizounToken.action).toBe("CONVERT_QWERTY");
      expect(arxizounToken.result).toBe("αρχιζοθν");
    });

    it("preserves 'white theme' and UI terminology in mixed Greek prompts without false positive conversion", () => {
      const input = "[Image #1] [Image #2] [Image #3] θελουν αλλαγες !! εχω επιλεξει το white theme [Image #4]";
      const detection = detectKeyboardLayoutMismatch(input);
      expect(detection.hasMismatch).toBe(false);

      const userQuestion = 'γιατι μου ενεργοποιειτε το εργαλειο όταν απλα γραφω την περιγραφη αγγλικη ορολογία "white theme" επισης νοιώθω οτι με το που ενεργοποιητε κατεθειαν εχει lag το app!!';
      const questionDetection = detectKeyboardLayoutMismatch(userQuestion);
      expect(questionDetection.hasMismatch).toBe(false);
    });
  });

  describe("zero-hardcoding smart layout engine", () => {
    it("converts unknown words absent from dictionaries in mixed Greek context", () => {
      const input = "εδω εχουμε ένα spiti και μια fotografia με syntetagmenes";
      const result = detectKeyboardLayoutMismatch(input);
      expect(result.hasMismatch).toBe(true);
      expect(result.convertedText).toBe("εδω εχουμε ένα σπιτι και μια φοτογραφια με συντεταγμενες");
      expect(toggleKeyboardLayout(input)).toBe("εδω εχουμε ένα σπιτι και μια φοτογραφια με συντεταγμενες");
    });

    it("preserves English technical terms in mixed context without dropping unknown words", () => {
      const input = "εδω εχουμε ένα spiti στον server με docker και max limit";
      const result = detectKeyboardLayoutMismatch(input);
      expect(result.hasMismatch).toBe(true);
      expect(result.convertedText).toBe("εδω εχουμε ένα σπιτι στον server με docker και max limit");
      expect(toggleKeyboardLayout(input)).toBe("εδω εχουμε ένα σπιτι στον server με docker και max limit");
    });

    it("converts individual words absent from static lists via Alt+G", () => {
      expect(toggleKeyboardLayout("spiti")).toBe("σπιτι");
      expect(toggleKeyboardLayout("fotografia")).toBe("φοτογραφια");
      expect(toggleKeyboardLayout("syntetagmenes")).toBe("συντεταγμενες");
    });

    it("performs universal Greeklish transliteration via smartTransliterateWord", () => {
      expect(smartTransliterateWord("arxizoun")).toBe("αρχίζουν");
      expect(smartTransliterateWord("thelw")).toBe("θέλω");
      expect(smartTransliterateWord("swsta")).toBe("σωστά");
      expect(smartTransliterateWord("kaneiw")).toBe("κάνεις");
      expect(smartTransliterateWord("syntetagmenes")).toBe("συντεταγμενες");
      expect(smartTransliterateWord("fotografia")).toBe("φοτογραφια");
    });

    it("scores phonotactics accurately via scoreGreekMismatch", () => {
      expect(scoreGreekMismatch("hello world from server")).toBe(0);
      expect(scoreGreekMismatch("arxizoun ta problhmata")).toBeGreaterThanOrEqual(4);
      expect(scoreGreekMismatch("l;auow")).toBeGreaterThanOrEqual(10);
    });

    it("identifies valid Greek layout morphology without static dictionaries", () => {
      expect(isRecognizedGreekLayout("spiti")).toBe(true);
      expect(isRecognizedGreekLayout("fotografia")).toBe(true);
      expect(isRecognizedGreekLayout("syntetagmenes")).toBe(true);
      expect(isRecognizedGreekLayout("sever")).toBe(false);
      expect(isRecognizedGreekLayout("foobarquux")).toBe(false);
    });
  });

  describe("handleEnglishKeyInput live typing", () => {
    it("maps physical Greek layout keys to English QWERTY when English mode is active", () => {
      const inserted: string[] = [];
      const onInsert = (ch: string) => inserted.push(ch);

      // User presses physical 'w' key (Greek 'ς')
      const wHandled = handleEnglishKeyInput(
        { key: "ς", code: "KeyW", shiftKey: false, preventDefault: () => {} },
        onInsert
      );
      expect(wHandled).toBe(true);
      expect(inserted).toEqual(["w"]);

      // User presses physical 'q' key (Greek dead key tonos)
      const qHandled = handleEnglishKeyInput(
        { key: "Dead", code: "KeyQ", shiftKey: false, preventDefault: () => {} },
        onInsert
      );
      expect(qHandled).toBe(true);
      expect(inserted).toEqual(["w", "q"]);

      // User presses physical 'q' key with Shift (uppercase Q)
      const qShiftHandled = handleEnglishKeyInput(
        { key: "Dead", code: "KeyQ", shiftKey: true, preventDefault: () => {} },
        onInsert
      );
      expect(qShiftHandled).toBe(true);
      expect(inserted).toEqual(["w", "q", "Q"]);

      // User types 'git' using physical Greek layout
      handleEnglishKeyInput({ key: "γ", code: "KeyG", shiftKey: false }, onInsert);
      handleEnglishKeyInput({ key: "ι", code: "KeyI", shiftKey: false }, onInsert);
      handleEnglishKeyInput({ key: "τ", code: "KeyT", shiftKey: false }, onInsert);
      expect(inserted.slice(3)).toEqual(["g", "i", "t"]);
    });

    it("maps Greek characters when event.code is absent", () => {
      const inserted: string[] = [];
      const onInsert = (ch: string) => inserted.push(ch);

      const handledA = handleEnglishKeyInput({ key: "α" }, onInsert);
      expect(handledA).toBe(true);
      expect(inserted).toEqual(["a"]);

      const handledFinalSigma = handleEnglishKeyInput({ key: "ς" }, onInsert);
      expect(handledFinalSigma).toBe(true);
      expect(inserted).toEqual(["a", "w"]);

      const handledQuestionMark = handleEnglishKeyInput({ key: ";" }, onInsert);
      expect(handledQuestionMark).toBe(true);
      expect(inserted).toEqual(["a", "w", ";"]);
    });

    it("passes through native ASCII characters and control keys", () => {
      const inserted: string[] = [];
      const onInsert = (ch: string) => inserted.push(ch);

      expect(handleEnglishKeyInput({ key: "a" }, onInsert)).toBe(false);
      expect(handleEnglishKeyInput({ key: "1" }, onInsert)).toBe(false);
      expect(handleEnglishKeyInput({ key: "Enter" }, onInsert)).toBe(false);
      expect(handleEnglishKeyInput({ key: "Backspace" }, onInsert)).toBe(false);
      expect(handleEnglishKeyInput({ key: "γ", ctrlKey: true }, onInsert)).toBe(false);
      expect(inserted).toEqual([]);
    });

    it("verifies bidirectional toggle from Greek to English switches target to non-Greek", () => {
      const greekInput = "καλημερα";
      const convertedToQwerty = toggleKeyboardLayout(greekInput);
      expect(convertedToQwerty).toBe("kalhmera");
      const isGreekTarget = /[\u0370-\u03FF]/.test(convertedToQwerty);
      expect(isGreekTarget).toBe(false);

      // When toggling back from QWERTY to Greek
      const convertedBackToGreek = toggleKeyboardLayout(convertedToQwerty);
      expect(convertedBackToGreek).toBe("καλημερα");
      const isGreekTargetBack = /[\u0370-\u03FF]/.test(convertedBackToGreek);
      expect(isGreekTargetBack).toBe(true);
    });
  });
});


it("keeps routine layout detection out of console and debug history, including after inspection", () => {
  const debugApi = (window as any).__SPACE_GREEK_LAYOUT_DEBUG__;
  const spies = ["log", "warn", "table", "groupCollapsed", "groupEnd"].map(name => vi.spyOn(console, name as "log").mockImplementation(() => {}));
  try {
    debugApi.clearHistory();
    const input = "please check the window performance ".repeat(300);
    detectKeyboardLayoutMismatch(input);
    expect(debugApi.getHistory()).toHaveLength(0);
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
    const inspected = debugApi.inspect("pethxe max arxizoun");
    expect(inspected.lastReport.tokens.length).toBeGreaterThan(0);
    debugApi.clearHistory();
    spies.forEach(spy => spy.mockClear());
    detectKeyboardLayoutMismatch(input);
    expect(debugApi.getHistory()).toHaveLength(0);
    spies.forEach(spy => expect(spy).not.toHaveBeenCalled());
  } finally {
    spies.forEach(spy => spy.mockRestore());
  }
});

describe("enterAddsLine", () => {
  it("adds a line only for a typed Enter on a touch-only device", () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(hover: none) and (pointer: coarse)" }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      expect(enterAddsLine({ isTrusted: true })).toBe(true);
      // The on-screen keyboard's synthetic Enter still sends.
      expect(enterAddsLine({ isTrusted: false })).toBe(false);
      matchMedia.mockImplementation(() => ({ matches: false }));
      expect(enterAddsLine({ isTrusted: true })).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
