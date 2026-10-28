// Stroke icons for the VN kit (docs/design): one 24×24 set at 1.8 weight, coloured by currentColor, used on the
// desktop and the phone alike. Never emoji in the chrome: they render differently on every system.

const svg = (body: string, cls = 'ic') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`

export const ICONS = {
  log: svg('<path d="M5 7h14M5 12h14M5 17h9"/>'),
  auto: svg('<path d="M8 5.5v13l10-6.5z"/>'),
  skip: svg('<path d="M5 6l7 6-7 6zM13 6l7 6-7 6z"/>'),
  mode: svg('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/>'),
  cmd: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="3"/><path d="M10 15.5l4-7"/>'),
  focus: svg('<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  slack: svg('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M4 7l8 6 8-6"/>'),
  costume: svg('<path d="M9 3.5h6l1 3-2 1.5 4 12.5H6l4-12.5L8 6.5z"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  more: svg('<circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  back: svg('<path d="M15 6l-6 6 6 6"/>'),
  reply: svg('<path d="M4 5.5h16v10H9l-5 4z"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="2"/>', 'ic fill'),
  send: svg('<path d="M4 12l16-7-6.5 15-2.5-6z"/>'),
  voiceOn: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11"/>'),
  voiceOff: svg('<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
  quest: svg('<path d="M12 3l9 9-9 9-9-9z"/>'),
  heart: svg('<path d="M12 20s-7-4.4-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.6-7 10-7 10z"/>'),
  actions: svg('<path d="M14.5 4.5l5 5L9 20H4v-5z"/>'),
  title: svg('<path d="M4 11l8-6.5 8 6.5M6 9.5V19h12V9.5"/>'),
  context: svg('<path d="M12 4l8.5 4.5L12 13 3.5 8.5z"/><path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5"/>'),
  stamina: svg('<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>'),
  week: svg('<path d="M19 14.5A7.5 7.5 0 119.5 5a6 6 0 009.5 9.5z"/>'),
  opus: svg('<path d="M12 3l9 9-9 9-9-9z"/>'),
  // Tools
  read: svg('<path d="M4 5.5h6a2 2 0 012 2V19a2 2 0 00-2-2H4zM20 5.5h-6a2 2 0 00-2 2V19a2 2 0 012-2h6z"/>'),
  edit: svg('<path d="M4 20l4-1 11-11-3-3L5 16z"/>'),
  shell: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5M12.5 15h4"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>'),
  web: svg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 2.5 14.5 0 17M12 3.5c-2.5 2.5-2.5 14.5 0 17"/>'),
  agent: svg('<circle cx="9" cy="9" r="3.5"/><path d="M3 19.5c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5"/><circle cx="17" cy="8" r="2.5"/><path d="M16 13.5c2.2 0 4 1.2 4.8 3.5"/>'),
  todo: svg('<path d="M12 3l9 9-9 9-9-9z"/><path d="M8.5 12l2.5 2.5 4.5-4.5"/>'),
  ask: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .6-1.5 1.2-1.5 2.3M12 17h.01"/>'),
  plan: svg('<path d="M3.5 6l5.5-2 6 2 5.5-2v14l-5.5 2-6-2-5.5 2zM9 4v14M15 6v14"/>'),
  plug: svg('<path d="M9 3.5v5M15 3.5v5M6.5 8.5h11V12a5.5 5.5 0 01-11 0zM12 17.5V21"/>'),
  skill: svg('<path d="M12 3.5l2.4 5 5.4.7-4 3.7 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.7 5.4-.7z"/>'),
  tool: svg('<path d="M14.5 6.5a4 4 0 00-5 5L4 17l3 3 5.5-5.5a4 4 0 005-5L15 12l-3-3z"/>'),
  ok: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  err: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  run: svg('<circle cx="12" cy="12" r="7"/><path d="M12 8v4l2.5 2"/>'),
} as const

export type IconName = keyof typeof ICONS
