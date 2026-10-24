import { expect, it } from 'vite-plus/test'
import { ApiError, request } from './api'

const respond = (status: number, body: string) => async () => new Response(body, { status })

it('returns parsed JSON', async () => {
  expect(await request('/health', {}, respond(200, '{"status":"ok"}'))).toEqual({ status: 'ok' })
})

it('surfaces the API detail message', async () => {
  const error = await request('/x', {}, respond(424, '{"detail":"NetSuite is unreachable"}')).catch(
    (e: unknown) => e,
  )
  expect(error).toBeInstanceOf(ApiError)
  expect(error).toMatchObject({
    status: 424,
    detail: 'NetSuite is unreachable',
    unreachable: false,
  })
})

it('treats a failed fetch or a gateway error as the API being down', async () => {
  const down = () => Promise.reject(new TypeError('fetch failed'))
  await expect(request('/x', {}, down)).rejects.toMatchObject({ unreachable: true })
  await expect(request('/x', {}, respond(502, ''))).rejects.toMatchObject({ unreachable: true })
})
