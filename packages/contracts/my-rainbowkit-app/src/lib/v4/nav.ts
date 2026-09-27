// src/lib/v4/nav.ts — moving around the app without a router.
//
// This is a static export with one page, so "navigation" is the query string plus a popstate event that
// the page already listens for. Keeping it here means an address can open a profile from anywhere without
// threading a callback down through every component that happens to render one.

/** Open a trader's profile. Clears the other view params so the URL describes exactly one thing. */
export function openTrader(address: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("trader", address.toLowerCase());
  url.searchParams.delete("trade");
  url.searchParams.delete("offer");
  url.searchParams.delete("tab");
  window.history.pushState(null, "", `${url.pathname}${url.search}`);
  // pushState does not fire popstate, and the page's own URL handling is what renders the profile.
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function closeTrader() {
  const url = new URL(window.location.href);
  url.searchParams.delete("trader");
  window.history.pushState(null, "", `${url.pathname}${url.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
