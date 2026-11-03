import type { MouseEvent } from 'react'
import { ChevronDown } from 'lucide-react'
import { ProjectDot } from '@/components/task/ProjectDot'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip } from '@/components/ui/tooltip'
import type { Project } from '@/domain/types'
import { cn } from '@/lib/utils'

const crumb =
  'inline-flex h-7 max-w-64 min-w-0 shrink items-center gap-1.5 rounded-md px-1.5 text-ui text-fg-secondary transition-colors duration-fast hover:bg-hover hover:text-fg hover:duration-instant'

export interface ProjectPickerProps {
  projects: readonly Project[]
  value: string | null
  onChange: (projectId: string) => void
  invalid?: boolean
}

/** Create mode: required choice of the task's project (header breadcrumb chip with a menu). */
export function ProjectPicker({ projects, value, onChange, invalid }: ProjectPickerProps) {
  const current = projects.find((project) => project.id === value) ?? null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Project: ${current ? current.name : 'none chosen'}`}
          aria-invalid={invalid || undefined}
          className={cn(
            crumb,
            'data-[state=open]:bg-active',
            !current && 'text-fg-tertiary',
            invalid && 'text-danger hover:text-danger',
          )}
        >
          {current ? <ProjectDot color={current.color} /> : null}
          <span className="truncate">{current ? current.name : 'Choose project'}</span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-tertiary" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Project</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={current?.id ?? ''} onValueChange={onChange}>
          {projects.map((project) => (
            <DropdownMenuRadioItem key={project.id} value={project.id}>
              <ProjectDot color={project.color} />
              <span className="truncate">{project.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A fixed project shown as context (subtasks stay in their parent's project). */
export function ProjectCrumb({
  project,
  reason,
}: {
  project: Pick<Project, 'name' | 'color'>
  reason: string
}) {
  return (
    <Tooltip content={reason}>
      <span
        tabIndex={0}
        aria-label={`Project: ${project.name}. ${reason}`}
        className={cn(crumb, 'cursor-default hover:bg-transparent hover:text-fg-secondary')}
      >
        <ProjectDot color={project.color} />
        <span className="truncate">{project.name}</span>
      </span>
    </Tooltip>
  )
}

/** Edit mode: link to the task's project (moving tasks between projects is out of scope). */
export function ProjectLink({
  project,
  onOpen,
}: {
  project: Pick<Project, 'id' | 'name' | 'color'>
  onOpen: () => void
}) {
  const href = `/projects/${encodeURIComponent(project.id)}`
  return (
    <Tooltip content="Open project · Tasks can’t be moved to another project">
      <a
        href={href}
        className={crumb}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          // Plain clicks go through the unsaved-changes guard; modified clicks open a new tab.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
          if (event.button !== 0) return
          event.preventDefault()
          onOpen()
        }}
      >
        <ProjectDot color={project.color} />
        <span className="truncate">{project.name}</span>
      </a>
    </Tooltip>
  )
}
