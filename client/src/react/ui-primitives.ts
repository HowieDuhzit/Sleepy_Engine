import React from 'react';

const h = React.createElement;

type BaseProps = {
  className?: string;
  children?: React.ReactNode;
};

export function UiCard({ className, children }: BaseProps) {
  return h('div', { className: `ui-card ${className ?? ''}`.trim() }, children);
}

type UiButtonProps = BaseProps & {
  variant?: 'default' | 'primary' | 'ghost';
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
};

export function UiButton({ className, children, variant = 'default', disabled, onClick, type = 'button' }: UiButtonProps) {
  const variantClass =
    variant === 'primary' ? 'ui-button-primary' : variant === 'ghost' ? 'ui-button-ghost' : '';
  return h(
    'button',
    {
      type,
      className: `ui-button ${variantClass} ${className ?? ''}`.trim(),
      disabled,
      onClick,
    },
    children
  );
}

type UiFieldProps = {
  label: string;
  className?: string;
  control: React.ReactNode;
};

export function UiField({ label, className, control }: UiFieldProps) {
  return h(
    'label',
    { className: `menu-field ${className ?? ''}`.trim() },
    h('span', null, label),
    control
  );
}

export function UiSelect(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return h('select', props);
}
