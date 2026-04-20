import { describe, expect, it } from 'vitest';
import { applyTransform } from '../parsers';
import { ValueTransform } from '../types';
import { loadUnitDefinitionsFixture, mockContext } from './helpers';

const noDefs = () => mockContext();
const withDefs = () =>
  mockContext({ unitDefinitions: loadUnitDefinitionsFixture() });

describe('applyTransform', () => {
  it('passes value through when type is none', () => {
    const t: ValueTransform = { type: 'none', config: {} };
    expect(applyTransform(42, t, noDefs())).toBe(42);
  });

  describe('boolean-map', () => {
    it('maps true/false to config values', () => {
      const t: ValueTransform = {
        type: 'boolean-map',
        config: { trueValue: 'open', falseValue: 'closed' },
      };
      expect(applyTransform(true, t, noDefs())).toBe('open');
      expect(applyTransform(false, t, noDefs())).toBe('closed');
    });

    it('falls back to truthy semantics for non-booleans', () => {
      const t: ValueTransform = {
        type: 'boolean-map',
        config: { trueValue: 'yes', falseValue: 'no' },
      };
      expect(applyTransform('x', t, noDefs())).toBe('yes');
      expect(applyTransform(0, t, noDefs())).toBe('no');
      expect(applyTransform('', t, noDefs())).toBe('no');
    });
  });

  describe('math', () => {
    const base: ValueTransform = {
      type: 'math',
      config: { operation: 'multiply', operand: 2 },
    };

    it('multiplies', () => {
      expect(applyTransform(5, base, noDefs())).toBe(10);
    });

    it('divides and guards zero operand', () => {
      const div: ValueTransform = {
        type: 'math',
        config: { operation: 'divide', operand: 4 },
      };
      expect(applyTransform(20, div, noDefs())).toBe(5);
      const divZero: ValueTransform = {
        type: 'math',
        config: { operation: 'divide', operand: 0 },
      };
      expect(applyTransform(5, divZero, noDefs())).toBe(5);
    });

    it('adds and subtracts', () => {
      expect(
        applyTransform(
          10,
          {
            type: 'math',
            config: { operation: 'add', operand: 3 },
          },
          noDefs()
        )
      ).toBe(13);
      expect(
        applyTransform(
          10,
          {
            type: 'math',
            config: { operation: 'subtract', operand: 4 },
          },
          noDefs()
        )
      ).toBe(6);
    });

    it('returns original value for non-numeric input and logs', () => {
      const ctx = noDefs();
      expect(applyTransform('abc', base, ctx)).toBe('abc');
      expect(ctx.debug).toHaveBeenCalled();
    });
  });

  describe('expression', () => {
    it('evaluates a mathjs expression over value', () => {
      const t: ValueTransform = {
        type: 'expression',
        config: { expression: 'value * 0.5 + 1' },
      };
      expect(applyTransform(10, t, noDefs())).toBe(6);
    });

    it('returns value on invalid expression', () => {
      const ctx = noDefs();
      const t: ValueTransform = {
        type: 'expression',
        config: { expression: 'nope(' },
      };
      expect(applyTransform(10, t, ctx)).toBe(10);
      expect(ctx.debug).toHaveBeenCalled();
    });
  });

  describe('unit (definitions-driven)', () => {
    it('converts Celsius to Kelvin via inverseFormula', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'K', fromUnit: 'C' },
      };
      expect(applyTransform(25, t, withDefs())).toBeCloseTo(298.15, 5);
    });

    it('converts hPa to Pa', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'Pa', fromUnit: 'hPa' },
      };
      expect(applyTransform(1013, t, withDefs())).toBeCloseTo(101300, 2);
    });

    it('converts knots to m/s', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'm/s', fromUnit: 'kn' },
      };
      expect(applyTransform(10, t, withDefs())).toBeCloseTo(5.14444, 3);
    });

    it('converts degrees to radians', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'rad', fromUnit: 'degree' },
      };
      expect(applyTransform(180, t, withDefs())).toBeCloseTo(Math.PI, 4);
    });

    it('converts percent to ratio', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'ratio', fromUnit: 'percent' },
      };
      expect(applyTransform(50, t, withDefs())).toBeCloseTo(0.5, 6);
    });

    it('honours legacy toUnit alias for baseUnit', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { toUnit: 'K', fromUnit: 'C' },
      };
      expect(applyTransform(0, t, withDefs())).toBeCloseTo(273.15, 5);
    });

    it('passes through when unitDefinitions is null', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'K', fromUnit: 'C' },
      };
      expect(applyTransform(25, t, noDefs())).toBe(25);
    });

    it('passes through when baseUnit is unknown', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'NotReal', fromUnit: 'C' },
      };
      const ctx = withDefs();
      expect(applyTransform(25, t, ctx)).toBe(25);
      expect(ctx.debug).toHaveBeenCalled();
    });

    it('passes through when fromUnit is unknown under a known base', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'K', fromUnit: 'unobtanium' },
      };
      const ctx = withDefs();
      expect(applyTransform(25, t, ctx)).toBe(25);
      expect(ctx.debug).toHaveBeenCalled();
    });

    it('passes through non-numeric values without NaN', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'K', fromUnit: 'C' },
      };
      const ctx = withDefs();
      expect(applyTransform('abc', t, ctx)).toBe('abc');
      expect(ctx.debug).toHaveBeenCalled();
    });

    it('passes through when a synthetic conversion formula throws', () => {
      const t: ValueTransform = {
        type: 'unit',
        config: { baseUnit: 'K', fromUnit: 'Bad' },
      };
      const defs = structuredClone(loadUnitDefinitionsFixture());
      (defs as any).K.conversions.Bad = {
        formula: 'value * 1',
        inverseFormula: 'syntax error (',
        symbol: 'bad',
      };
      const ctx = mockContext({ unitDefinitions: defs });
      expect(applyTransform(10, t, ctx)).toBe(10);
      expect(ctx.debug).toHaveBeenCalled();
    });
  });
});
