import { cva, type VariantProps } from 'class-variance-authority'

/**
 * Button recipe (also used for links styled as buttons). Heights follow the control tokens:
 * xs 24px · sm 28px (default, toolbars/menus) · md 32px (forms, dialogs) · icon 28px square.
 */
export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap select-none',
    'transition-[background-color,border-color,color,box-shadow,opacity] duration-fast hover:duration-instant',
    'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-active',
        secondary:
          'border border-default bg-surface text-fg shadow-[0_1px_0_0_var(--border-subtle)] hover:border-strong hover:bg-hover active:bg-active',
        outline: 'border border-default bg-transparent text-fg hover:bg-hover active:bg-active',
        ghost:
          'bg-transparent text-fg-secondary hover:bg-hover hover:text-fg active:bg-active data-[state=open]:bg-active data-[state=open]:text-fg',
        danger: 'bg-danger text-danger-fg hover:bg-danger-hover active:bg-danger-hover',
        'danger-ghost': 'bg-transparent text-danger hover:bg-danger-subtle active:bg-danger-subtle',
        link: 'h-auto px-0 text-accent-text underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-6 px-2 text-meta [&_svg:not([class*=size-])]:size-3.5',
        sm: 'h-7 px-2.5 text-ui',
        md: 'h-8 px-3 text-ui',
        icon: 'size-7 p-0',
        'icon-sm': 'size-6 p-0 [&_svg:not([class*=size-])]:size-3.5',
      },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'secondary', size: 'sm' },
  },
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>
