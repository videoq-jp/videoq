---
title: Use VideoQ from Codex
description: Connect Codex to VideoQ's MCP tools for scene search and video inspection.
---

# Use VideoQ from Codex

Codex can choose VideoQ tools directly through MCP. VideoQ's internal LangGraph
agent is not involved in these external requests. Codex uses its own model
login; the VideoQ key below authenticates access to your courses and tools.

## Connect

1. Sign in to VideoQ, open **Settings**, and create an integration API key with
   read-only access. Keep the key available for the next step.
2. Install [Codex CLI](https://developers.openai.com/codex/cli), run `codex login`,
   and complete sign-in. An existing Codex login can be reused.
3. Add this table to `~/.codex/config.toml` (or `$CODEX_HOME/config.toml` if you
   use a custom Codex home):

```toml
[mcp_servers.videoq]
url = "https://videoq.jp/api/mcp"
env_http_headers = { "X-API-Key" = "VIDEOQ_API_KEY" }
required = true
startup_timeout_sec = 30
tool_timeout_sec = 180
enabled_tools = [
  "list_courses", "get_course_info", "search_scenes", "read_video_window",
  "overview_video", "skim_video", "inspect_clip", "focus_clip",
  "list_course_skills", "get_course_skill", "read_course_skill_resource"
]
```

For an on-premises installation, replace `https://videoq.jp` with your VideoQ
origin. If video inspection is disabled there, omit `inspect_clip` and
`focus_clip` from the allow list.

4. In a Bash terminal, enter the VideoQ key without echoing it, then start Codex
   from the same terminal:

```bash
read -r -s -p "VideoQ API key: " VIDEOQ_API_KEY
printf '\n'
export VIDEOQ_API_KEY
codex
```

The configuration contains only the environment variable's name. Keep the key
out of prompts, configuration files, shell history and version control. Desktop
clients need the environment variable in their own launch environment; exporting
it in a terminal applies to clients started from that terminal.

See the [official Codex MCP configuration reference](https://developers.openai.com/codex/mcp)
for `env_http_headers` and tool allow lists.

## Search and inspect

Start by asking:

> Use VideoQ MCP to list the courses I can access. Show each course's name and ID.

Then use an ID returned by `list_courses`:

> In course_id 42, explain the difference between sampling and quantization.
> Search the subtitles and cite the video title and actual timestamps supporting
> each explanation. Use only the retrieved evidence.

For a particular video:

> In course_id 42, identify the video titled “Lecture 1” using get_course_info
> with video_limit 20. Inspect the images from 11:52 to 12:00 and explain what is
> visible, citing the observation timestamps. Say if visual evidence is unavailable.

Replace the example ID, title and times with your own. Every external evidence
call needs `course_id`; video IDs must belong to that course. `get_course_info`
returns at most 20 videos per page; follow `videos_meta.next_offset` when needed.
For speech, use `search_scenes` and `read_video_window`. For known visual
intervals, use `inspect_clip` (up to 180 seconds) or `focus_clip` (up to 16
seconds). Use `overview_video` and `skim_video` to find an interval when its
location is unknown. See [visual evidence](visual-evidence.md) for limits.

For a one-off command instead of the interactive client:

```bash
codex exec --ephemeral --skip-git-repo-check --sandbox read-only --json \
  'Use only VideoQ MCP. List my accessible courses with their IDs. Do not edit files.'
```

`--json` emits tool-call and usage events as JSON Lines. These events can contain
private course information, transcripts and observations; keep any saved output
private. `--ephemeral` avoids saving the Codex session, but does not erase output
you save yourself.

## Apply published course Skills

In a VideoQ installation with course Skills enabled, the course owner generates,
reviews and publishes each skill and enables distribution. An empty skill list
can mean that no reviewed version is available or that the current user lacks access.

For Codex clients without the MCP Skills extension, use the standard tools in the
allow list above plus the small `videoq-course-skills` local skill. From a checkout
of the matching VideoQ version, copy the folder into your target project's skill directory:

```bash
mkdir -p /path/to/project/.agents/skills
cp -R integrations/codex/skills/videoq-course-skills /path/to/project/.agents/skills/
```

Restart Codex in that project, then ask:

> Use $videoq-course-skills to apply the published knowledge from course 42 to this task.

The local skill contains retrieval instructions. It discovers published metadata,
fetches the selected manifest and reads its instructions and sources through MCP.
Course knowledge stays on the server until requested; the local skill is not a copy
of a course. Every lookup rechecks access and source validity. Stop using a version
when a lookup returns `SKILL_UNAVAILABLE`; the server cannot erase material already
read into a conversation. This compatibility route does not imply native support for
`skills/list` or automatic registration of every course skill in Codex's catalog.

## Limits and troubleshooting

- `401`: check that the variable was exported before starting Codex, the key has
  not been revoked, and the URL points to the correct installation.
- `403`: the key or course access does not permit the requested operation. An
  allow list controls which tools Codex sees; it does not grant permissions.
- `429`: honor `Retry-After`. API-key request limits and account/tool limits are
  separate; initialization and discovery also make requests.
- `video_limit` validation error: request 20 or fewer and paginate.
- `VISUALS_NOT_PREPARED`: ask the course owner or administrator to prepare the
  uploaded video's visual cache. Do not infer screen contents from subtitles.

External search and image inspection consume the course owner's AI allowance
per tool call. Metadata and subtitle-only reads do not consume that allowance.
Codex's model usage is separate. Its model, instructions and process startup can
differ from VideoQ's chat, so latency and token totals do not isolate the choice
of agent framework.

After a temporary integration check, revoke the test key in VideoQ Settings and
run `unset VIDEOQ_API_KEY` in the terminal. Remove the `mcp_servers.videoq` table
if you no longer want the connection configured.
