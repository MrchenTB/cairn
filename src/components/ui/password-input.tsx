import { useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { Input } from './input'

export interface PasswordInputProps extends Omit<ComponentProps<'input'>, 'type'> {
  /** What the toggle reveals, for its accessible name: "Show {revealLabel}" (default "password"). */
  revealLabel?: string
  /** Class for the wrapper (width, margins); `className` styles the input itself. */
  wrapperClassName?: string
}

/**
 * Password field (32px) with a show/hide toggle. The toggle keeps one accessible name and
 * reports its state with aria-pressed; visibility resets when the field unmounts.
 */
export function PasswordInput({
  className,
  wrapperClassName,
  revealLabel = 'password',
  disabled,
  ...props
}: PasswordInputProps) {
  const [shown, setShown] = useState(false)
  return (
    <div className={cn('relative', wrapperClassName)}>
      <Input
        {...props}
        type={shown ? 'text' : 'password'}
        disabled={disabled}
        className={cn('pr-9', className)}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        className="absolute top-1 right-1"
        aria-label={`Show ${revealLabel}`}
        aria-pressed={shown}
        disabled={disabled}
        onClick={() => setShown((value) => !value)}
      >
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  )
}
