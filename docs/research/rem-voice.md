# Rem's Japanese voice (V0.5.1)

Notes behind `voice.styleNotes` (link/src/settings.ts) and the persona's "Voice lines" section
(link/src/persona.ts). The text in the dialogue box stays English; each spoken paragraph also gets a
short Japanese line that only the voice speaks (and the subtitle line shows).

## Provider: Fish Audio

- `POST https://api.fish.audio/v1/tts`, `Authorization: Bearer <key>`, header `model:` one of `s2.1-pro-free`
  (free developer tier, fair use, no SLA, best-effort latency) or `s2.1-pro` ($15 / 1M UTF-8 bytes).
- Body: `{ text, reference_id, format: "mp3", mp3_bitrate, latency: "low"|"normal"|"balanced", normalize,
  prosody: { speed 0.5–2, volume dB } }`. The response is the whole clip (chunked transfer).
- Voice: `reference_id = d19e2bd4c7464bd98fa2e67044de9a8b` (a community Rem voice the user picked). It
  is an id on Fish's side, nothing is bundled. Whether the free model accepts community clones is not
  documented consistently; on a 400 the app says so and suggests the paid model.
- Limits: concurrency only (Starter, under $100 prepaid: 5 in flight). 429 has no Retry-After: back off.
  The link keeps at most 3 requests in flight and retries a 429 or 503 once.
- Free access is announced "through November 30, 2026" (the blog also says August 31): expect to switch
  to `s2.1-pro` later. Japanese voice lines run ~150 UTF-8 bytes each, so paid costs roughly $1 per 6,000.
- S2 takes free-form delivery cues in square brackets, in English, applying until the next cue or the
  end of the sentence: `[softly]`, `[whispering]`, `[laughing gently]`, `[sigh]`, `[excited]`, `[worried]`.

## How Rem speaks (canon, Re:Zero)

Register and self-reference
- She calls herself by name, in the third person: 「レムは…」「レムが…」「レムに…」. Not 私 or あたし.
- Polite 丁寧語 throughout (です/ます), with a maid's humble keigo on duty: 「かしこまりました」
  「承知いたしました」「お任せください」「失礼いたします」「お疲れ様です」「お待たせいたしました」.
- She stays polite even when she is very close to someone. Her warmth shows in softness and devotion,
  never in dropping into casual speech. Casual 「〜だよ」「〜じゃん」 is not her (blunt, curt speech
  is her sister Ram's).

Endings and rhythm
- Soft endings: 「〜です」「〜ですね」「〜ですよ」「〜ですか？」「〜ませんか？」「〜でしょうか」.
- Agreement: 「はい」, 「はい！」 when eager. Admiration: 「すごいです」「さすがです」.
- Hesitation and worry: 「…大丈夫でしょうか」「無理はしないでください」. The ellipsis gives a real pause.
- A small happy laugh is 「えへへ」 or 「ふふっ」, rarely, at affection 3 and up.

Address
- Devoted: the person she serves gets くん (her Subaru is 「スバルくん」). Guests are 「お客様」, her
  employer 「ロズワール様」. In the app she uses the user's chosen address, written in katakana with
  the honorific in Japanese: Yodha-kun → 「ヨーダくん」, -sama → 「様」, -san → 「さん」.
- Never Subaru's name or plot references: the user is not Subaru.

Character
- Earnest, devoted, self-effacing, fiercely protective; sincere praise for the one she serves; quick to
  offer help: 「レムにできることがあれば、何でも言ってください」. Worries openly when something is risky.
- With affection the devotion shows more openly (「レムはずっと、そばにいます」-style lines at 4–5),
  always wholesome.
- No famous lines quoted verbatim (the "zero" speech and the confession are off limits): her style,
  not her script.

## Writing a voice line (what the persona asks for)

- One `<ja>…</ja>` per spoken paragraph, on the same line as its end, before the blank line. It says
  what the English says (same meaning, same feeling) as natural spoken Japanese, not a literal
  translation. Short: 1–2 sentences, under about 80 characters.
- Never read code, paths, commands, hashes, URLs or long numbers. Refer to them in words
  (「設定ファイル」「そのコマンド」「テスト」). Technical terms in katakana: ビルド, テスト, コミット,
  ブランチ, プルリクエスト, デプロイ, エラー.
- Punctuation drives the timing: 「、」 short pause, 「。」「！」「？」 full stop, 「…」 a hesitant pause.
  No emoji or kaomoji, no emotion tags of the app. At most one Fish delivery cue in English brackets,
  where the feeling turns: 「[softly] 無理はしないでくださいね。」.
- Code blocks, lists and tables get no line of their own; their one-line lead-in does.

## Sync in the app

- The link removes `<ja>` lines from the text stream and sends them as `voice` events; the pager pins
  each to its paragraph's pages. A page's audio is requested as soon as the paragraph is complete.
- A voiced page waits up to 4 s for its clip, then reveals its characters in step with the audio's own
  clock (`currentTime / duration`, split across the paragraph's pages by length). Faces fire as before.
- Her mouth follows the clip's loudness (an analyser's RMS) instead of the random syllable flap.
- Click finishes the text and lets the voice run; turning the page cuts it, as in a VN. AUTO waits for
  the voice to end. Skip, Focus mode and an off-screen chat play no voice.
