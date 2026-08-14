const WORKSPACE_PREFIX = "/workspace"

function assetRequest(request) {
  const url = new URL(request.url)
  if (url.pathname === WORKSPACE_PREFIX) {
    url.pathname = "/"
  } else if (url.pathname.startsWith(`${WORKSPACE_PREFIX}/`)) {
    url.pathname = url.pathname.slice(WORKSPACE_PREFIX.length) || "/"
  } else {
    return null
  }
  return new Request(url, request)
}

export default {
  async fetch(request, env) {
    const asset = assetRequest(request)
    if (!asset) return new Response("Not Found", { status: 404 })
    return env.ASSETS.fetch(asset)
  },
}
