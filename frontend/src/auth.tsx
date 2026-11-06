import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, setUnauthorizedHandler, tokenStore } from './api'

export type Role = 'admin' | 'operator' | 'viewer'
export interface User {
  id: number
  username: string
  display_name?: string | null
  role: Role
  role_label: string
  must_change_password: boolean
}

interface AuthCtx {
  user: User | null
  loading: boolean
  login: (u: string, p: string) => Promise<void>
  logout: () => void
  refresh: () => Promise<void>
  can: (...roles: Role[]) => boolean
  expired: boolean
}

const Ctx = createContext<AuthCtx>(null as unknown as AuthCtx)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [expired, setExpired] = useState(false)

  const logout = useCallback(() => {
    tokenStore.clear()
    setUser(null)
  }, [])

  const refresh = useCallback(async () => {
    if (!tokenStore.get()) { setLoading(false); return }
    try {
      setUser(await api<User>('/api/v1/auth/me'))
    } catch {
      /* 서버 미연결 시 토큰은 유지 (다음 시도) */
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => {
      tokenStore.clear()
      setUser(null)
      setExpired(true)
    })
    refresh()
  }, [refresh])

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ access_token: string; user: User }>('/api/v1/auth/login', { method: 'POST', body: { username, password } })
    tokenStore.set(r.access_token)
    setExpired(false)
    setUser(r.user)
  }, [])

  const can = useCallback((...roles: Role[]) => !!user && roles.includes(user.role), [user])

  return <Ctx.Provider value={{ user, loading, login, logout, refresh, can, expired }}>{children}</Ctx.Provider>
}

export const useAuth = () => useContext(Ctx)
