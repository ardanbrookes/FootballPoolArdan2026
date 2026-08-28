/**
 * The reaction GIFs the chat picker offers.
 *
 * A fixed pack rather than live search: Tenor's v1 API is discontinued, Tenor v2
 * needs a Google Cloud key, and Giphy's public demo key is banned. None of those
 * are things a league of eight friends should have to set up, so these are
 * hand-picked instead — every id below was fetched and confirmed to return a
 * real GIF in both sizes before being written here.
 *
 * Two sizes off Giphy's CDN, which is public and built for embedding:
 *   200w_s.gif  a still, ~11 KB — what the picker grid shows
 *   200w.gif    animated, ~280 KB — what actually gets posted
 *
 * That split is why opening the picker costs well under a megabyte instead of
 * the ~14 MB it would take to animate every tile at once.
 */

const CDN = 'https://media.giphy.com/media'

export const gifCategories = [
  { label: "Applause", ids: ["YRuFixSNWFVcXaxpmX", "31lPv5L3aIvTi", "Rgn6cUfaN5zW"] },
  { label: "Celebrate", ids: ["4ZdkTRmMjHbe1iGLFN", "o5fllTCmqGJ5pCNf1o", "ORVArZlFq0DSyVJ6C8"] },
  { label: "Crying", ids: ["OBhDa8A9ZBIUU", "t5qY8FyyM85a0", "3S04b09ljsDeg"] },
  { label: "Facepalm", ids: ["vwI4mYEHP8k0w", "TJawtKM6OCKkvwCIqX", "WrNfErHio7ZAc"] },
  { label: "Fail", ids: ["SNglbUSgSxKuI", "CANQcbL6B28pi", "bwnzbsw3YwRs4"] },
  { label: "Hype", ids: ["fu8htuZjAwr8BVulhu", "IluIZ0hx7oMcX5C95H", "ifBHrvJbqLnsJkobhl"] },
  { label: "Laughing", ids: ["aC1PWOXzqgT6hhC0vZ", "CoDp6NnSmItoY", "XHeLeuirRbwptHhSWd"] },
  { label: "Let's go", ids: ["RrVzUOXldFe8M", "Qw4X3FnmFFCPANtlhtK", "5UAofAl6g5t1GL5nO8"] },
  { label: "Mind blown", ids: ["3OSo3PPaXdw0U", "5aLrlDiJPMPFS", "l0NwHXQy3kUSfFF60"] },
  { label: "Nervous", ids: ["HThocT5vEPT9K", "3oz8xLlw6GHVfokaNW", "bEVKYB487Lqxy"] },
  { label: "Nice", ids: ["SShJcu4ySty1G6MX9A", "l41lUjUgLLwWrz20w", "tIeCLkB8geYtW"] },
  { label: "Pain", ids: ["1rSpWBPEGeuMTjdQUs", "eIq8fAxe9fPdtAowmK", "v9Yf7G2RghFzYkISjk"] },
  { label: "Shocked", ids: ["QUENDfi6DEMLzQ0CKt", "5VKbvrjxpVJCM", "IYjcAIri8C7f8LvLor"] },
  { label: "Shrug", ids: ["jPAdK8Nfzzwt2", "eLvhchyvNNOuLbOtYP", "SAHGcjT1jNvDB6oxI8"] },
  { label: "Touchdown", ids: ["XJtM2nNFCzT3etvzOB", "21D3EMwC7tt977IAio", "l0HlOoFk1ejtUIoGQ"] },
  { label: "Trash talk", ids: ["TjMBTXRVwuNRTsWHWp", "4xt8cUz1wrr54WrKQE", "5zhrKLEMIMS9oYicAi"] },
]

/** A still frame — cheap, used for the picker grid. */
export const stillUrl = (id) => `${CDN}/${id}/200w_s.gif`

/** The animated version — what actually gets posted to chat. */
export const animatedUrl = (id) => `${CDN}/${id}/200w.gif`

/**
 * Only URLs of exactly this shape render as images in chat.
 *
 * Deliberately narrow. Chat used to render any pasted image or Tenor/Giphy
 * link, which is how people ended up posting share links that showed as bare
 * text — those pages aren't images. Restricting rendering to URLs the picker
 * itself produces means what you see in the picker is what everyone gets.
 */
export const GIF_URL_RE = /^https:\/\/media\.giphy\.com\/media\/[A-Za-z0-9]+\/200w\.gif$/
