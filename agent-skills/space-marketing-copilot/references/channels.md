# Channel playbooks

Every channel: one post per brief unless the brief asks for more; the published post's own URL is the
evidence (`space_marketing_publish_done`). Limits and caps come from `space_marketing_state`, never from here.

## Media sizes (`space_screenshot` `aspect`)
- X: 16:9 or 1:1; a video lasts at most 140 s.
- LinkedIn: 1:1 or 4:5 (they fill the feed); a video 1:1 or 16:9.
- YouTube: 16:9; a Short is 9:16.
- Product Hunt gallery: 16:9. Reddit: 16:9 or 1:1 where the subreddit allows media.
- Hacker News: text only. GitHub, dev.to and the blog: 16:9 images inside the text.

## X (x.com) — kinds POST, THREAD
- 280 characters per post; a THREAD body separates posts with a line holding only `---`.
- One idea, one link, at most two hashtags (#selfhosted, #AIagents). Lead with what the reader gets.
- Publish: https://x.com/compose/post, type each part (the "+" adds the next post of a thread), Post.
- URL: `https://x.com/<handle>/status/<id>`.

## LinkedIn — kinds POST, ARTICLE
- Up to 3000 characters; the first two lines carry the post (the rest folds). Plain language, no hashtag lists.
- Publish: https://www.linkedin.com/feed/ → "Start a post", type, Post.
- URL: the post's "Copy link to post" (`https://www.linkedin.com/feed/update/urn:li:activity:<id>/`).

## Reddit — kind POST (always reviewed by default)
- Pick subreddits that allow it (r/selfhosted, r/LocalLLaMA, r/opensource only when the rules allow
  self-promotion); read the sidebar rules and remember them as CHANNEL_RULE with the subreddit as key.
- Title says what it is; the body says "I built this", what problem it solves, how to try it, what feedback you
  want. No marketing voice. One subreddit per post; never cross-post the same text the same day.
- Publish: https://www.reddit.com/r/<sub>/submit, choose the flair the rules require, Post.
- URL: `https://www.reddit.com/r/<sub>/comments/<id>/<slug>/`.

## Hacker News — kind LAUNCH (Show HN; always reviewed by default)
- Title: `Show HN: SpaceApp – <what it is in plain words>` (no superlatives, no emoji, under 80 characters).
- Body (the first comment): who built it and why, what it does, how to try it, what is not done yet.
- Publish: https://news.ycombinator.com/submit (title + url to the repository or site), then add the first
  comment on the item page. Never ask anyone to upvote.
- URL: `https://news.ycombinator.com/item?id=<id>`.

## Product Hunt — kind LAUNCH (always reviewed by default)
- Tagline (60 characters), description, the maker's first comment, gallery images (assets).
- Publish: https://www.producthunt.com/posts/new; launches are scheduled with the operator (ask for the date).
- URL: `https://www.producthunt.com/posts/<slug>`.

## dev.to — kind ARTICLE
- A useful article (how SpaceApp runs many CLIs side by side, a setup walkthrough) with front matter tags
  (`selfhosted`, `ai`, `devtools`, `opensource` only if the license allows the word). Code blocks real and tested.
- Publish: https://dev.to/new, paste title and markdown, Publish.
- URL: `https://dev.to/<user>/<slug>`.

## Blog (spaceapp.dev) — kind ARTICLE
- The site lives in its own repository; a BLOG post is a markdown article the operator publishes there.
  Draft it, ask for review, and report the live URL on spaceapp.dev once the operator says it is up.

## YouTube — kind VIDEO
- Videos are made with the `space-hyperframes` skill (product-launch-video, faceless-explainer) as pane
  files; title under 70 characters, a description with the install command and links.
- Publish: https://studio.youtube.com → Create → Upload videos (file upload), fill title and description,
  visibility as the brief says.
- URL: `https://www.youtube.com/watch?v=<id>`.

## GitHub — kinds RELEASE_NOTE, POST
- Release notes: what changed for users, grouped (New, Improved, Fixed), with upgrade steps; facts from the
  release itself. Discussions posts for announcements.
- Publish in the repository's Releases or Discussions page; never open pull requests to third-party lists
  (awesome-lists) without the operator's review.
- URL: `https://github.com/<owner>/<repo>/releases/tag/<tag>` or the discussion URL.
