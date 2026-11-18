import { z } from 'zod'
import { AppError } from './domain.mjs'

const identitySchema = z.object({
  sub: z.string().min(1).max(255),
  email: z.email().max(180).transform(value => value.toLowerCase()),
  email_verified: z.literal(true),
  name: z.string().optional(),
  hd: z.string().optional(),
})

export async function googleIdentity(code, verifier, config, fetcher) {
  const tokenResponse = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, code_verifier: verifier, client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: `${config.origin}/api/auth/google/callback`, grant_type: 'authorization_code' }).toString(),
  })
  if (!tokenResponse.ok) throw new AppError('구글 인증에 실패했습니다. 다시 로그인해 주세요.', 401)
  const token = await tokenResponse.json()
  if (typeof token.access_token !== 'string' || !token.access_token) throw new AppError('구글 인증 응답을 확인할 수 없습니다.', 502)
  const profileResponse = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
    redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token.access_token}` },
  })
  if (!profileResponse.ok) throw new AppError('구글 계정 정보를 확인할 수 없습니다.', 401)
  const identity = identitySchema.safeParse(await profileResponse.json())
  if (!identity.success) throw new AppError('이메일이 인증된 구글 계정으로 로그인해 주세요.', 403)
  return identity.data
}
