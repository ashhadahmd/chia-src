import { motion } from 'motion/react'
import { useAuth } from '../lib/useAuth'
import { FILTERS, useFilter, type Filter } from '../lib/filter'
import { SignOut } from '@phosphor-icons/react'
import AgentsCard from './AgentsCard'
import Brand from './Brand'
import DriveCard from './DriveCard'
import ThemeSwitch from './ThemeSwitch'

export default function Sidebar({ counts }: { counts: Record<Filter, number> }) {
  const [filter, setFilter] = useFilter()
  const { user, logout } = useAuth()

  return (
    <aside className="sidebar">
      <Brand />
      <nav className="nav" aria-label="Collections">
        {FILTERS.map(({ value, label, icon: Icon }) => {
          const active = filter === value
          return (
            <button
              key={value}
              className="nav-item"
              data-active={active}
              data-kind={value}
              aria-current={active ? 'page' : undefined}
              onClick={() => setFilter(value)}
            >
              {active && <motion.span layoutId="nav-pill" className="nav-pill" />}
              <Icon weight={active ? 'fill' : 'regular'} className="nav-icon" />
              <span className="nav-label">{label}</span>
              <span className="nav-count">{counts[value] || ''}</span>
            </button>
          )
        })}
      </nav>
      <div className="sidebar-foot">
        <AgentsCard />
        <DriveCard />
        <ThemeSwitch />
        <div className="me">
          <span className="avatar" aria-hidden="true">{user?.username.slice(0, 1).toUpperCase()}</span>
          <span className="me-text">
            <span className="me-name">{user?.username}</span>
            <span className="me-mail">{user?.email}</span>
          </span>
          <button className="icon-btn" onClick={logout} aria-label="Sign out" title="Sign out">
            <SignOut />
          </button>
        </div>
      </div>
    </aside>
  )
}
