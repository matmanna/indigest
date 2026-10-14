// Slack message payloads covering every shape Indigest stores: user rich
// text, bot section blocks, attachments, forwards and plain-text fallbacks.
const t = (text: string, style?: Record<string, boolean>) => ({
  type: "text",
  text,
  ...(style ? { style } : {}),
});
const section = (...elements: any[]) => ({
  type: "rich_text_section",
  elements,
});
const rich = (...elements: any[]) => ({
  blocks: [{ type: "rich_text", block_id: "b1", elements }],
});

export const slackMessages: Record<string, any> = {
  plainRichText: {
    ts: "1700000000.000100",
    user: "U1",
    text: "hello world",
    ...rich(section(t("hello world"))),
  },
  styledRichText: {
    ts: "1700000000.000200",
    user: "U1",
    text: "fallback",
    ...rich(
      section(
        t("Plain "),
        t("bold", { bold: true }),
        t(" and "),
        t("italic", { italic: true }),
        t(" and "),
        t("struck", { strike: true }),
        t(" and "),
        t("code()", { code: true }),
        t(" and "),
        t("both ", { bold: true, italic: true }),
        t(".\n\nSecond paragraph & <angle> text."),
      ),
    ),
  },
  linksMentionsEmoji: {
    ts: "1700000000.000300",
    user: "U1",
    text: "fallback",
    ...rich(
      section(
        t("See "),
        { type: "link", url: "https://example.com/a?b=c&d=e", text: "the docs" },
        t(", "),
        { type: "link", url: "https://example.org" },
        t(", ask "),
        { type: "user", user_id: "U2" },
        t(" in "),
        { type: "channel", channel_id: "C9" },
        t(" "),
        { type: "emoji", name: "tada" },
        t(" "),
        { type: "broadcast", range: "here" },
        { type: "usergroup", usergroup_id: "S1" },
        { type: "date", timestamp: 1700000000, format: "{date}", fallback: "Nov 14" },
        { type: "link", url: "https://bold.example", text: "bold link", style: { bold: true } },
      ),
    ),
  },
  listsQuotesCode: {
    ts: "1700000000.000400",
    user: "U1",
    text: "fallback",
    ...rich(
      section(t("Intro\n")),
      {
        type: "rich_text_list",
        style: "bullet",
        indent: 0,
        elements: [section(t("first")), section(t("second ", {}), t("bold", { bold: true }))],
      },
      {
        type: "rich_text_list",
        style: "bullet",
        indent: 1,
        elements: [section(t("nested"))],
      },
      {
        type: "rich_text_list",
        style: "ordered",
        indent: 0,
        offset: 2,
        elements: [section(t("third")), section(t("fourth"))],
      },
      { type: "rich_text_quote", elements: [t("quoted line\nsecond quoted")] },
      { type: "rich_text_preformatted", elements: [t("const a = 1 < 2;\nreturn *a*;")] },
      section(t("Outro")),
    ),
  },
  botSectionBlocks: {
    ts: "1700000000.000500",
    bot_id: "B1",
    username: "Announcer",
    text: "fallback text",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: "*Bold* bot text with <https://x.com|a link>" } },
      { type: "section", text: { type: "plain_text", text: "Plain & simple" } },
      { type: "divider" },
      { type: "context", elements: [{ type: "mrkdwn", text: "_context_" }, { type: "image", image_url: "x" }] },
      { type: "actions", elements: [] },
    ],
  },
  botActionsOnlyBlocks: {
    ts: "1700000000.000550",
    bot_id: "B1",
    text: "Only the fallback text <@U3>",
    blocks: [{ type: "actions", elements: [] }],
  },
  attachmentsOnly: {
    ts: "1700000000.000600",
    bot_id: "B2",
    text: "",
    attachments: [
      {
        pretext: "Pre",
        title: "Attachment title",
        text: "*attachment* text",
        fields: [{ title: "Field", value: "Value" }],
      },
    ],
  },
  forwardedBlank: {
    ts: "1700000000.000700",
    user: "U4",
    text: "",
    attachments: [
      {
        author_id: "U5",
        author_name: "orig",
        ts: "1690000000.000100",
        text: "Original _forwarded_ text",
        is_share: true,
      },
    ],
  },
  forwardedWithComment: {
    ts: "1700000000.000800",
    user: "U4",
    text: "my comment",
    blocks: [{ type: "rich_text", elements: [section(t("my "), t("comment", { italic: true }))] }],
    attachments: [{ author_id: "U5", author_name: "orig", ts: "1690000000.000200", text: "orig text" }],
  },
  nestedMessage: {
    ts: "1700000000.000900",
    user: "U4",
    text: "",
    message: {
      ts: "1690000000.000300",
      user: "U6",
      text: "nested fallback",
      ...rich(section(t("nested "), t("rich", { bold: true }))),
    },
  },
  emptyBlocksFallback: {
    ts: "1700000000.001000",
    user: "U1",
    text: "Just *text* with <#C1|general> and <!channel>",
    blocks: [],
  },
  noBlocks: {
    ts: "1700000000.001100",
    user: "U1",
    text: "No blocks <https://y.com|label> &amp; stuff",
  },
  linkOnly: {
    ts: "1700000000.001200",
    user: "U1",
    text: "<https://only.link>",
    ...rich(section({ type: "link", url: "https://only.link" })),
  },
  italicSentenceWithLinks: {
    ts: "1700000000.001400",
    user: "U1",
    text: "fallback",
    ...rich(
      section(
        t("Disclosure/", { italic: true }),
        {
          type: "link",
          url: "https://en.wikipedia.org/wiki/Wikipedia:Conflict_of_interest",
          text: "COI",
          style: { italic: true },
        },
        t(" notice: I maintain ", { italic: true }),
        { type: "link", url: "https://slickclient.net/", text: "Slick", style: { italic: true } },
        t(", the biggest mod.", { italic: true }),
        t("\nNext line "),
        t("bold\nacross lines", { bold: true }),
      ),
    ),
  },
  emptyRichText: {
    ts: "1700000000.001300",
    user: "U1",
    text: "",
    ...rich(section(t(""))),
  },
};
