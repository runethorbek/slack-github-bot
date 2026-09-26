import re
import time
from dataclasses import dataclass

from people_due import (
    MAX_SCANNED_PEOPLE,
    PEOPLE_PAGE_SIZE,
    PeopleDueCommandError,
    fetch_notion_pages,
    query_data_source,
)
from people_interaction import (
    AddInteractionCommandError,
    INTERACTION_TRACK_PROPERTY,
    add_interaction_button,
    fetch_available_interaction_types,
    fetch_available_tracks,
)
from tasks_list import (
    MalformedTrackPageError,
    NotionAuthenticationError,
    TaskListCommandError,
    call_notion_with_retries,
    copenhagen_today,
    notion_headers,
    track_from_notion_page,
)


PEOPLE_SUGGEST_FAILURE_MESSAGE = (
    "Unable to prepare a suggested message right now. Please try again later."
)
GEMINI_TRANSIENT_FAILURE_MESSAGE = (
    "Gemini is currently experiencing high demand. Please try again shortly."
)
INTERACTION_TYPE_UNAVAILABLE_NOTE = (
    "Add interaction is unavailable right now (couldn't load Notion Type options)."
)
MAX_SUGGESTION_INTERACTIONS = 5

# Bounds the number of distinct Track ids resolved per command, so a Person
# or their recent Interactions cannot drive an unbounded number of Notion
# reads (one GET per distinct Track id, never per Interaction).
MAX_SUGGESTION_TRACKS = 5

# Notion property name for the People -> Tracks relation, exactly as named
# in the live schema. The Interactions -> Tracks relation's equivalent,
# INTERACTION_TRACK_PROPERTY, is defined once in people_interaction.py
# (which also writes it) and imported above, rather than duplicated here.
PERSON_TRACK_PROPERTY = "Track Goal"

# Suggestions beyond this are dropped by Python, whatever Gemini returns.
MAX_NEXT_STEP_SUGGESTIONS = 2

# The one next-step kind that is not a live Interaction Type option.
WAIT_NEXT_STEP_KIND = "Wait"

# Delimits the recap from the next-step part in the recap call's response.
NEXT_STEP_MARKER = "NEXT STEP:"

# Recognizes the marker line leniently - any case, wrapped in Markdown
# emphasis or a heading, or followed by a suggestion on the same line - so
# a slightly off-format next-step part is still split off and validated
# rather than leaking unvalidated into the recap. A recap bullet ("- ...")
# never matches. Group 1 is any text after the colon.
NEXT_STEP_MARKER_PATTERN = re.compile(
    r"^[\s#*_]*(?:suggested\s+)?next\s+steps?[\s*_]*:[\s*_]*(.*)$",
    re.IGNORECASE,
)

# Slack rejects a section block whose mrkdwn text exceeds this length. Gemini's
# draft has no length cap of its own, so the block (not the plain-text
# fallback, which has a much higher limit) must be defensively truncated.
SLACK_SECTION_TEXT_LIMIT = 3000

# Notion People property display names, exactly as named in the schema.
PERSON_CONTEXT_PROPERTIES = (
    "Why this person",
    "Relationship intent",
    "Relationship status",
    "Relationship strength",
    "Interests",
    "Expertise",
    "Notes",
)

SUGGESTION_SYSTEM_INSTRUCTION = """
You are drafting a short reconnect message on behalf of the user. The user
will review the draft before deciding whether to send anything themselves.

Rules:
- Use only the context supplied below.
- Do not invent facts, relationship history, interests, commitments, or
  meetings that are not present in the supplied context.
- Do not decide who to contact; a person to contact has already been chosen.
- Draft a short, natural reconnect message.
- Keep it concise.
- Avoid sounding sales-oriented.
- Do not mention Notion, CRM fields, cadence, or internal metadata.
- If there is not enough context for a specific message, produce a generic
  but honest draft rather than inventing details.
- Respond with only the drafted message text, with no preamble or
  explanation.
"""

# The recap rules shared by both recap prompt variants; each variant adds
# its own final "Respond with" rule so the two never contradict each other.
RECAP_RULES = """
You are preparing a short private recap for the user about a Person, so
they can quickly recall relevant context before reaching out. This recap
is for the user only; it is never sent to the Person.

Rules:
- Use only the context supplied below.
- Do not invent facts, relationship history, interests, commitments,
  meetings, or Track membership that are not present in the supplied
  context.
- Summarize the most relevant recent Interactions in roughly 2 to 4 short
  bullet points. Do not mechanically restate every Interaction line by
  line; synthesize what matters.
- If Relevant Tracks are supplied below, add one final bullet naming them
  exactly as given, for example "Relevant Track: <name>". Never rename,
  invent, or omit a supplied Track name.
- If no Relevant Tracks are supplied, do not mention Track at all.
- If there are no previous Interactions, write one honest bullet saying
  so rather than inventing history.
"""

RECAP_SYSTEM_INSTRUCTION = f"""{RECAP_RULES}- Respond with only the bullet list (each line starting with "- "), with
  no heading, preamble, or explanation.
"""

RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION = f"""{RECAP_RULES}- Respond with only the bullet list (each line starting with "- "),
  followed by the next-step part described below, with no other heading,
  preamble, or explanation.

After the recap bullet list, also suggest the user's next relationship
action with this Person. This part is also private to the user.

Rules for the next step:
- Use only the context supplied below. Do not invent history, meetings,
  commitments, interests, or Track membership.
- Each suggestion's kind must be exactly one of the ALLOWED NEXT STEP
  KINDS listed below, spelled exactly as given.
- "{WAIT_NEXT_STEP_KIND}" means reaching out now seems premature given the
  context.
- Give 1 suggestion when there is little context. Give at most
  {MAX_NEXT_STEP_SUGGESTIONS}, and a second only when the context supports a
  distinct alternative.
- Keep each reason or idea to one short sentence.
- Format: after the recap bullets, write one line containing exactly
  "{NEXT_STEP_MARKER}", then one line per suggestion in the form
  "- <Kind>: <short reason or idea>". Use no bold or other formatting.
"""


@dataclass(frozen=True)
class PersonProfile:
    page_id: str
    name: str
    context_fields: tuple[tuple[str, str], ...]
    track_ids: tuple[str, ...] = ()


@dataclass(frozen=True)
class InteractionSummary:
    date: str | None
    type: str | None
    title: str | None
    notes: str | None
    track_ids: tuple[str, ...] = ()


def person_not_found_message(person_name):
    return f'No Person found matching "{person_name}".'


def ambiguous_person_message(person_name):
    return (
        f'Multiple People match "{person_name}" exactly; '
        "cannot determine which one was meant."
    )


def external_error_status_code(error):
    """Mirrors main.py's helper of the same name for the injected Gemini
    ``generate_text`` call, which raises whatever the SDK raised rather
    than a shared exception type.
    """
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if isinstance(status_code, int):
        return status_code
    for attribute in ("status_code", "code"):
        status_code = getattr(error, attribute, None)
        if isinstance(status_code, int):
            return status_code
    return None


def is_transient_gemini_status(status_code):
    """A 429 (rate limit) or 5xx Gemini response is transient/high-demand."""
    return status_code == 429 or (isinstance(status_code, int) and 500 <= status_code < 600)


def handle_people_suggest(
    person_name,
    post_slack_message,
    notion_post,
    generate_text,
    environment,
    today=None,
    sleep=time.sleep,
    notion_get=None,
):
    """Handle `/people suggest <person>`.

    Notion access, Person resolution, and Track resolution stay entirely
    deterministic; Gemini (via the injected ``generate_text``) only ever
    sees the bounded context built here and is only ever asked to
    summarize or draft text, never to choose a Person, infer a Track, or
    perform a side effect. ``notion_get`` is optional so Track relations
    can be resolved without requiring every caller to supply it; when
    omitted, Track context is simply left out of the recap.
    """
    root_message = post_slack_message(f"/people suggest {person_name}")

    try:
        command_today = today or copenhagen_today()
        profile, is_ambiguous = resolve_person(
            notion_post,
            environment["NOTION_API_KEY"],
            environment["NOTION_PEOPLE_DATA_SOURCE_ID"],
            person_name,
            sleep,
        )
        interactions = (
            fetch_recent_interactions(
                notion_post,
                environment["NOTION_API_KEY"],
                environment["NOTION_INTERACTIONS_DATA_SOURCE_ID"],
                profile.page_id,
                command_today,
                sleep,
            )
            if profile is not None
            else []
        )
    except PeopleDueCommandError:
        post_slack_message(
            PEOPLE_SUGGEST_FAILURE_MESSAGE, thread_ts=root_message["ts"]
        )
        return

    if is_ambiguous:
        post_slack_message(
            ambiguous_person_message(person_name), thread_ts=root_message["ts"]
        )
        return
    if profile is None:
        post_slack_message(
            person_not_found_message(person_name), thread_ts=root_message["ts"]
        )
        return

    track_ids = collect_track_ids(profile, interactions)[:MAX_SUGGESTION_TRACKS]
    resolved_tracks = resolve_track_names(
        track_ids, notion_get, environment["NOTION_API_KEY"], sleep
    )
    track_names = relevant_track_names(track_ids, resolved_tracks)

    selectable_tracks = fetch_selectable_tracks(
        notion_post, environment, sleep
    )
    default_track_id = (
        profile.track_ids[0] if len(profile.track_ids) == 1 else None
    )
    selectable_interaction_types = fetch_selectable_interaction_types(
        notion_get, environment, sleep
    )
    next_step_kinds = allowed_next_step_kinds(selectable_interaction_types)

    try:
        recap_response = generate_text(
            build_recap_prompt(profile, interactions, track_names, next_step_kinds)
        ).strip()
        answer = generate_text(build_suggestion_prompt(profile, interactions)).strip()
    except Exception as error:
        if not is_transient_gemini_status(external_error_status_code(error)):
            raise
        post_slack_message(
            GEMINI_TRANSIENT_FAILURE_MESSAGE, thread_ts=root_message["ts"]
        )
        return
    recap, next_steps = split_recap_and_next_steps(recap_response, next_step_kinds)
    next_step_text = format_next_steps(next_steps)
    message = format_suggestion_message(profile.name, answer)
    reply_text = format_full_reply(recap, message, next_step_text)
    if not selectable_interaction_types:
        reply_text = f"{reply_text}\n\n{INTERACTION_TYPE_UNAVAILABLE_NOTE}"
    post_slack_message(
        reply_text,
        thread_ts=root_message["ts"],
        blocks=build_suggestion_blocks(
            profile,
            recap,
            message,
            selectable_tracks,
            default_track_id,
            selectable_interaction_types,
            next_step_text,
        ),
    )


def allowed_next_step_kinds(interaction_types):
    """The live Interaction Type options plus Wait, or nothing at all.

    Without live Type options no next step is requested or shown - not
    even Wait alone - so no Type list is ever hardcoded here.
    """
    if not interaction_types:
        return []
    kinds = list(interaction_types)
    if WAIT_NEXT_STEP_KIND not in kinds:
        kinds.append(WAIT_NEXT_STEP_KIND)
    return kinds


def split_recap_and_next_steps(response, allowed_kinds):
    """Split the recap call's response into (recap, next steps).

    Gemini's next-step part is advisory text only and is validated here:
    a suggestion whose kind is not exactly an allowed kind is dropped, at
    most MAX_NEXT_STEP_SUGGESTIONS are kept, and a missing or unparseable
    next-step part yields no suggestions rather than an error. Without
    allowed kinds no next step was requested, so the response is the recap.
    """
    if not allowed_kinds:
        return response, []

    lines = response.splitlines()
    for marker_index, line in enumerate(lines):
        marker_match = NEXT_STEP_MARKER_PATTERN.match(line)
        if marker_match:
            break
    else:
        return response, []

    recap = "\n".join(lines[:marker_index]).strip()
    # A suggestion written on the marker line itself is still validated.
    suggestion_lines = [marker_match.group(1), *lines[marker_index + 1 :]]
    next_steps = []
    for line in suggestion_lines:
        next_step = parse_next_step(line, allowed_kinds)
        if next_step is not None:
            next_steps.append(next_step)
    return recap, next_steps[:MAX_NEXT_STEP_SUGGESTIONS]


def parse_next_step(line, allowed_kinds):
    """Parse one "- <Kind>: <idea>" line, or None if it is not valid.

    The kind must be exactly an allowed kind. Matching by prefix rather
    than splitting at the first colon keeps a live Type option whose name
    itself contains a colon matchable; the longest kind wins.
    """
    suggestion = line.strip()
    for bullet in ("- ", "* ", "• "):
        if suggestion.startswith(bullet):
            suggestion = suggestion[len(bullet) :].strip()
            break
    for kind in sorted(allowed_kinds, key=len, reverse=True):
        if suggestion.startswith(f"{kind}:"):
            idea = suggestion[len(kind) + 1 :].strip()
            return (kind, idea) if idea else None
    return None


def fetch_selectable_interaction_types(notion_get, environment, sleep):
    """Fetch the live Interaction Type options for the Add Interaction button.

    Unlike Track (optional), a Type is required for every Interaction
    write, so a fetch failure here must not silently offer a button that
    could open a modal with no valid Type field. An empty result - whether
    from a Notion failure or a misconfigured schema - means the caller
    must omit the Add Interaction button entirely (see
    build_suggestion_blocks) rather than show one that cannot safely open
    a modal, satisfying "do not open a modal that permits an unchecked
    write" without needing the Vercel webhook to touch Notion itself.
    """
    if notion_get is None:
        return []
    try:
        return fetch_available_interaction_types(
            notion_get,
            environment["NOTION_API_KEY"],
            environment["NOTION_INTERACTIONS_DATA_SOURCE_ID"],
            sleep,
        )
    except (TaskListCommandError, AddInteractionCommandError, NotionAuthenticationError):
        return []


def fetch_selectable_tracks(notion_post, environment, sleep):
    """Fetch every Track offerable in the Add Interaction modal's selector.

    Best-effort: a listing failure - including a Notion credential failure -
    must not break the rest of the `/people suggest` reply, since Track
    selection is optional and the rest of the reply (recap, draft, Add
    Interaction button) is still fully usable without it. An unconfigured
    Tracks data source (NOTION_TRACKS_DATA_SOURCE_ID) simply yields no
    Track options rather than an error.
    """
    tracks_data_source_id = environment.get("NOTION_TRACKS_DATA_SOURCE_ID", "")
    if not tracks_data_source_id:
        return []
    try:
        return fetch_available_tracks(
            notion_post, environment["NOTION_API_KEY"], tracks_data_source_id, sleep
        )
    except (TaskListCommandError, AddInteractionCommandError, NotionAuthenticationError):
        return []


def resolve_person(notion_post, api_key, people_data_source_id, person_name, sleep):
    """Find the Person whose Name matches exactly, ignoring case.

    Returns (profile, is_ambiguous). profile is None when there is no exact
    match; is_ambiguous is True when more than one Person matches, in which
    case the caller must not guess which one was meant.
    """

    def build_request_json(cursor):
        request_json = {"page_size": PEOPLE_PAGE_SIZE}
        if cursor:
            request_json["start_cursor"] = cursor
        return request_json

    pages, _ = fetch_notion_pages(
        notion_post,
        api_key,
        people_data_source_id,
        build_request_json,
        MAX_SCANNED_PEOPLE,
        PEOPLE_PAGE_SIZE,
        sleep,
    )

    target = person_name.casefold()
    matches = [
        profile
        for profile in (person_profile_from_notion_page(page) for page in pages)
        if profile is not None and profile.name.casefold() == target
    ]
    if len(matches) != 1:
        return None, len(matches) > 1
    return matches[0], False


def person_profile_from_notion_page(page):
    try:
        properties = page["properties"]
        name_property = properties["Name"]
        if name_property.get("type") != "title":
            return None
        name = " ".join(
            "".join(
                part.get("plain_text", "") for part in name_property.get("title", [])
            ).split()
        )
        page_id = page["id"]
        if not name or not page_id:
            return None
    except (AttributeError, KeyError, TypeError):
        return None

    context_fields = tuple(
        (property_name, value)
        for property_name in PERSON_CONTEXT_PROPERTIES
        for value in [extract_property_text(properties, property_name)]
        if value is not None
    )
    track_ids = extract_relation_ids(properties, PERSON_TRACK_PROPERTY)
    return PersonProfile(
        page_id=page_id, name=name, context_fields=context_fields, track_ids=track_ids
    )


def fetch_recent_interactions(
    notion_post, api_key, interactions_data_source_id, person_page_id, today, sleep
):
    request_json = {
        "page_size": MAX_SUGGESTION_INTERACTIONS,
        "filter": {
            "and": [
                {"property": "People", "relation": {"contains": person_page_id}},
                {"property": "Date", "date": {"is_not_empty": True}},
                {
                    "property": "Date",
                    "date": {"on_or_before": today.isoformat()},
                },
            ]
        },
        "sorts": [{"property": "Date", "direction": "descending"}],
    }
    pages = query_data_source(
        notion_post, api_key, interactions_data_source_id, request_json, sleep
    )

    summaries = []
    for page in pages[:MAX_SUGGESTION_INTERACTIONS]:
        summary = interaction_summary_from_notion_page(page)
        if summary is not None:
            summaries.append(summary)
    return summaries


def interaction_summary_from_notion_page(page):
    try:
        properties = page["properties"]
    except (AttributeError, KeyError, TypeError):
        return None
    if not isinstance(properties, dict):
        return None

    date_value = extract_interaction_date(properties)
    type_value = extract_property_text(properties, "Type")
    title_value = extract_title_text(properties)
    notes_value = extract_property_text(properties, "Notes")

    if not any((date_value, type_value, title_value, notes_value)):
        return None

    track_ids = extract_relation_ids(properties, INTERACTION_TRACK_PROPERTY)
    return InteractionSummary(
        date=date_value,
        type=type_value,
        title=title_value,
        notes=notes_value,
        track_ids=track_ids,
    )


def extract_interaction_date(properties):
    date_property = properties.get("Date")
    if not isinstance(date_property, dict) or date_property.get("type") != "date":
        return None
    start = (date_property.get("date") or {}).get("start")
    return start if isinstance(start, str) and start else None


def extract_title_text(properties):
    for property_value in properties.values():
        if isinstance(property_value, dict) and property_value.get("type") == "title":
            text = "".join(
                part.get("plain_text", "") for part in property_value.get("title", [])
            ).strip()
            if text:
                return text
    return None


def extract_property_text(properties, display_name):
    """Read a People/Interaction property as plain text, if it exists.

    Only the text-shaped Notion property types actually used by this schema
    are recognized. A missing property, or one of a type not recognized
    here, is safely omitted rather than guessed at.
    """
    property_value = properties.get(display_name)
    if not isinstance(property_value, dict):
        return None

    property_type = property_value.get("type")
    if property_type == "rich_text":
        text = "".join(
            part.get("plain_text", "") for part in property_value.get("rich_text", [])
        ).strip()
        return text or None
    if property_type == "select":
        select = property_value.get("select") or {}
        name = select.get("name")
        return name if isinstance(name, str) and name else None
    if property_type == "multi_select":
        names = [
            option.get("name")
            for option in property_value.get("multi_select", [])
            if isinstance(option, dict) and option.get("name")
        ]
        return ", ".join(names) if names else None
    return None


def extract_relation_ids(properties, display_name):
    """Read a relation property's related page ids, if present.

    A missing property, or one not shaped as a relation, is safely
    treated as no relation rather than guessed at.
    """
    property_value = properties.get(display_name)
    if not isinstance(property_value, dict) or property_value.get("type") != "relation":
        return ()
    return tuple(
        relation["id"]
        for relation in property_value.get("relation", [])
        if isinstance(relation, dict) and relation.get("id")
    )


def collect_track_ids(profile, interactions):
    """Distinct Track ids from the Person and their recent Interactions.

    Order is preserved (Person first, then each Interaction in the order
    given) and duplicates are dropped, so a Track referenced by several
    Interactions is still resolved at most once.
    """
    seen = []
    for track_id in profile.track_ids:
        if track_id not in seen:
            seen.append(track_id)
    for interaction in interactions:
        for track_id in interaction.track_ids:
            if track_id not in seen:
                seen.append(track_id)
    return tuple(seen)


def resolve_track_names(track_ids, notion_get, api_key, sleep):
    """Resolve each distinct Track id to a name, at most once per id.

    Mirrors tasks_list.resolve_tracks: bounded to one GET per distinct
    Track id, never per Interaction. A Track that fails to resolve, or is
    malformed, is silently omitted rather than surfaced as an error, since
    Track context here is only ever a best-effort aid for the recap.
    Notion credential failures still propagate, matching the Tasks Track
    resolution path.
    """
    resolved = {}
    if notion_get is None:
        return resolved

    for track_id in track_ids:
        if track_id in resolved:
            continue
        try:
            response = call_notion_with_retries(
                lambda track_id=track_id: notion_get(
                    f"https://api.notion.com/v1/pages/{track_id}",
                    headers=notion_headers(api_key),
                    timeout=10,
                ),
                sleep,
                credential_failure_status_codes=(401,),
            )
            try:
                track_page = response.json()
            except (TypeError, ValueError) as error:
                raise MalformedTrackPageError() from error
            resolved[track_id] = track_from_notion_page(track_page).name
        except (TaskListCommandError, MalformedTrackPageError):
            resolved[track_id] = None
    return resolved


def relevant_track_names(track_ids, resolved_tracks):
    names = []
    for track_id in track_ids:
        name = resolved_tracks.get(track_id)
        if name and name not in names:
            names.append(name)
    return names


def build_context_block(profile, interactions):
    context_lines = [f"Name: {profile.name}"]
    context_lines.extend(
        f"{label}: {value}" for label, value in profile.context_fields
    )

    if interactions:
        interaction_lines = [
            "- " + "; ".join(formatted_interaction_fields(interaction))
            for interaction in interactions
        ]
        interactions_block = "\n".join(interaction_lines)
    else:
        interactions_block = "No previous Interactions are recorded."

    person_context = "\n".join(context_lines)
    return (
        f"PERSON CONTEXT:\n{person_context}\n\n"
        f"RECENT INTERACTIONS:\n{interactions_block}\n"
    )


def build_suggestion_prompt(profile, interactions):
    return f"{SUGGESTION_SYSTEM_INSTRUCTION}\n\n{build_context_block(profile, interactions)}"


def build_recap_prompt(profile, interactions, track_names, next_step_kinds=()):
    context_block = build_context_block(profile, interactions)
    if track_names:
        tracks_block = "\n".join(f"- {name}" for name in track_names)
        context_block = f"{context_block}\nRELEVANT TRACKS:\n{tracks_block}\n"
    if not next_step_kinds:
        return f"{RECAP_SYSTEM_INSTRUCTION}\n\n{context_block}"
    kinds_block = "\n".join(f"- {kind}" for kind in next_step_kinds)
    context_block = f"{context_block}\nALLOWED NEXT STEP KINDS:\n{kinds_block}\n"
    return f"{RECAP_WITH_NEXT_STEP_SYSTEM_INSTRUCTION}\n\n{context_block}"


def formatted_interaction_fields(interaction):
    fields = []
    if interaction.date:
        fields.append(f"Date: {interaction.date}")
    if interaction.type:
        fields.append(f"Type: {interaction.type}")
    if interaction.title:
        fields.append(f"Title: {interaction.title}")
    if interaction.notes:
        fields.append(f"Notes: {interaction.notes}")
    return fields


def format_suggestion_message(person_name, answer):
    return f"Suggested message for {person_name}:\n\n{answer}"


def format_next_steps(next_steps):
    if not next_steps:
        return ""
    lines = "\n".join(f"- {kind}: {idea}" for kind, idea in next_steps)
    return f"Suggested next step:\n{lines}"


def format_full_reply(recap, message, next_step_text=""):
    parts = []
    if recap:
        parts.append(f"Context:\n{recap}")
    if next_step_text:
        parts.append(next_step_text)
    parts.append(message)
    return "\n\n".join(parts)


def build_suggestion_blocks(
    profile,
    recap,
    message_text,
    tracks=(),
    default_track_id=None,
    interaction_types=(),
    next_step_text="",
):
    blocks = []
    if recap:
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": truncate_for_slack_section(f"Context:\n{recap}"),
                },
            }
        )
    if next_step_text:
        blocks.append(
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": truncate_for_slack_section(next_step_text),
                },
            }
        )
    blocks.append(
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": truncate_for_slack_section(message_text),
            },
        }
    )
    # A Type dropdown is required for a usable Add Interaction modal, so the
    # button itself is only offered when there is at least one live Type
    # option to populate it with - see fetch_selectable_interaction_types.
    if interaction_types:
        blocks.append(
            {
                "type": "actions",
                "elements": [
                    add_interaction_button(
                        profile.page_id,
                        profile.name,
                        tracks,
                        default_track_id,
                        interaction_types,
                    )
                ],
            }
        )
    return blocks


def truncate_for_slack_section(text):
    if len(text) <= SLACK_SECTION_TEXT_LIMIT:
        return text
    suffix = "…"
    return text[: SLACK_SECTION_TEXT_LIMIT - len(suffix)] + suffix
