import React from 'react';

const h = React.createElement;

function cx(...parts: Array<string | undefined | null | false>) {
  return parts.filter(Boolean).join(' ');
}

type BaseProps = {
  className?: string;
  children?: React.ReactNode;
};

export function UiCard({ className, children }: BaseProps) {
  return h('div', { className: cx('ui-card shad-card', className) }, children);
}

export function UiSectionTitle({ className, children }: BaseProps) {
  return h('h3', { className: cx('shad-section-title', className) }, children);
}

export function UiDivider({ className }: { className?: string }) {
  return h('div', { className: cx('shad-divider', className) });
}

type UiButtonProps = BaseProps & {
  variant?: 'default' | 'primary' | 'ghost' | 'outline';
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
};

export function UiButton({ className, children, variant = 'default', disabled, onClick, type = 'button' }: UiButtonProps) {
  const variantClass =
    variant === 'primary'
      ? 'ui-button-primary'
      : variant === 'ghost'
      ? 'ui-button-ghost'
      : variant === 'outline'
      ? 'ui-button-outline'
      : '';
  return h(
    'button',
    {
      type,
      className: cx('ui-button shad-button', variantClass, className),
      disabled,
      onClick,
    },
    children
  );
}

type UiInputProps = React.InputHTMLAttributes<HTMLInputElement> & { className?: string };

export function UiInput({ className, ...props }: UiInputProps) {
  return h('input', {
    ...props,
    className: cx('ui-input shad-input', className),
  });
}

type UiSelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { className?: string };

export function UiSelect({ className, ...props }: UiSelectProps) {
  return h('select', {
    ...props,
    className: cx('ui-input shad-input shad-select', className),
  });
}

type UiFieldProps = {
  label: string;
  className?: string;
  control: React.ReactNode;
};

export function UiField({ label, className, control }: UiFieldProps) {
  return h(
    'label',
    { className: cx('menu-field shad-field', className) },
    h('span', { className: 'shad-field-label' }, label),
    control
  );
}

type UiSwitchRowProps = {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
};

export function UiSwitchRow({ label, checked, onChange, className }: UiSwitchRowProps) {
  return h(
    'label',
    { className: cx('settings-menu-check shad-switch-row', className) },
    h('input', {
      type: 'checkbox',
      checked,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked),
    }),
    h('span', null, label)
  );
}

type UiRangeRowProps = {
  label: string;
  valueLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onInput: (value: number) => void;
  className?: string;
};

export function UiRangeRow({ label, valueLabel, min, max, step, value, onInput, className }: UiRangeRowProps) {
  return h(
    'label',
    { className: cx('settings-menu-field shad-range-row', className) },
    h('span', { className: 'shad-range-label' }, `${label}: `, h('strong', null, valueLabel)),
    h('input', {
      type: 'range',
      min,
      max,
      step,
      value,
      onInput: (event: React.FormEvent<HTMLInputElement>) => onInput(parseFloat(event.currentTarget.value)),
    })
  );
}
