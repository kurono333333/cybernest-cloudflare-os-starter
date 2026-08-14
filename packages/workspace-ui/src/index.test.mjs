import assert from 'node:assert/strict'
import test from 'node:test'
import worker from './index.mjs'

function assetsResponse() {
  return new Response('asset')
}

test('maps the Workspace UI root to the asset root', async () => {
  const requests = []
  const env = {
    ASSETS: {
      fetch(request) {
        requests.push(new URL(request.url).pathname)
        return Promise.resolve(assetsResponse())
      },
    },
  }

  const response = await worker.fetch(
    new Request('https://dev.dennoba.net/workspace'),
    env,
  )

  assert.equal(response.status, 200)
  assert.deepEqual(requests, ['/'])
})

test('strips only the Workspace prefix from nested asset requests', async () => {
  const requests = []
  const env = {
    ASSETS: {
      fetch(request) {
        requests.push(new URL(request.url).pathname)
        return Promise.resolve(assetsResponse())
      },
    },
  }

  const response = await worker.fetch(
    new Request('https://dev.dennoba.net/workspace/assets/index.js?cache=1'),
    env,
  )

  assert.equal(response.status, 200)
  assert.deepEqual(requests, ['/assets/index.js'])
})

test('does not serve paths outside the Workspace prefix', async () => {
  let assetFetches = 0
  const env = {
    ASSETS: {
      fetch() {
        assetFetches += 1
        return Promise.resolve(assetsResponse())
      },
    },
  }

  const response = await worker.fetch(
    new Request('https://dev.dennoba.net/manager/os'),
    env,
  )

  assert.equal(response.status, 404)
  assert.equal(assetFetches, 0)
})
