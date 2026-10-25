# Campaign playbooks

A campaign groups posts toward one goal. The operator starts one from a template in the Posts tab, approves
one you propose (`space_marketing_campaign_propose {templateId, name, goal, channels}`), or a new SpaceApp
version proposes its release campaign on its own. An approved campaign arrives as a BRIEF; draft its posts with
`campaignId` set, ask for reviews, and schedule them (`scheduledAt`) in the order below.

## release — Release announcement (GitHub, X, LinkedIn, dev.to)
1. GitHub release notes from the version's changes (New, Improved, Fixed; upgrade with
   `npx --yes run-spaceapp@latest update`). Facts only from the release itself and the capabilities spec.
2. X thread (3–5 posts): the one change most users feel first, then two more, then how to try it.
3. LinkedIn post the next day: the same story for team leads, one link.
4. dev.to article within the week when the release has a story worth a walkthrough.

## product-hunt — Product Hunt launch
- Ask the operator for the launch date first (`space_marketing_question_ask`).
- Kit: tagline (60 characters), description, the maker's first comment, 3–5 gallery images (pane files),
  topics. Launch-day posts on X and LinkedIn scheduled for the launch hour. Never ask for upvotes.

## show-hn — Show HN
- One submission: `Show HN: SpaceApp – <plain description>` linking the repository or site; the maker's first
  comment (who, why, what, how to try, what is not done). Reviewed every time; never resubmit within the limit.

## weekly-tip — Weekly tip
- One concrete workflow a week (a room layout, a copilot, a skill), as a short X post and a LinkedIn post
  scheduled a day apart. Rotate topics; recall LESSON memories so tips do not repeat.

## demo-video — Demo video
- Script and produce a 60–120 second video with the `space-hyperframes` skill (pane files), then the YouTube
  title and description (with the install command) and an X post linking it once it is up.
