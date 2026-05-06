// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

using Newtonsoft.Json.Linq;
using System.Collections.Immutable;

namespace Kusto.Vscode;

public abstract class Setting
{
    public string Name { get; }

    protected Setting(string name)
    {
        Name = name;
    }
}

/// <summary>
/// General settings for values of type <see cref="T"/>
/// </summary>
/// <typeparam name="T"></typeparam>
public class Setting<T> : Setting
{
    public T DefaultValue { get; }

    public Setting(string name, T defaultValue) : base(name)
    {
        this.DefaultValue = defaultValue;
    }

    /// <summary>
    /// Gets the value if defined in the settings.
    /// </summary>
    public virtual bool TryGetValue(ImmutableDictionary<string, object?> settings, out T value)
    {
        if (settings.TryGetValue(this.Name, out var objValue))
        {
            if (objValue is T tvalue)
            {
                value = tvalue;
                return true;
            }
            else if (objValue == null && typeof(T).CanBeNull())
            {
                value = (T)objValue!;
            }
            else
            {
                try
                {
                    value = (T)Convert.ChangeType(objValue, typeof(T))!;
                    return true;
                }
                catch
                {
                }
            }
        }

        value = default!;
        return false;
    }

    /// <summary>
    /// Gets the value (or the default value if not defined in the settings).
    /// </summary>
    public T GetValue(ImmutableDictionary<string, object?> settings)
    {
        if (TryGetValue(settings, out var value))
        {
            return value;
        }
        else
        {
            return this.DefaultValue;
        }
    }

    /// <summary>
    /// Updates the settings with the value for this setting.
    /// </summary>
    public virtual ImmutableDictionary<string, object?> WithValue(ImmutableDictionary<string, object?> settings, T value)
    {
        return settings.SetItem(this.Name, value!);
    }
}

/// <summary>
/// A Setting for an array or list of items of type <see cref="T"/>
/// </summary>
/// <typeparam name="T"></typeparam>
public class ArraySetting<T> : Setting<ImmutableList<T>>
{
    public ArraySetting(string name, ImmutableList<T> defaultValue) : base(name, defaultValue)
    {
    }

    public override bool TryGetValue(ImmutableDictionary<string, object?> settings, out ImmutableList<T> value)
    {
        if (settings.TryGetValue(this.Name, out var objValue))
        {
            if (objValue is JArray jarray)
            {
                value = jarray.ToObject<ImmutableList<T>>()!;
                return value != null;
            }
            else if (objValue is IEnumerable<T> enumerable)
            {
                value = enumerable.ToImmutableList();
                return true;
            }
        }

        value = default!;
        return false;
    }
}

/// <summary>
/// A Setting for a type that is mapped to and from a string value in the settings.
/// </summary>
/// <typeparam name="T"></typeparam>
public class StringMappedSetting<T> : Setting<T>
    where T : notnull
{
    private readonly ImmutableDictionary<string, T> _map;
    private readonly ImmutableDictionary<T, string> _reverseMap;

    public StringMappedSetting(string name, T defaultValue, ImmutableDictionary<string, T> valueMapping)
        : base(name, defaultValue)
    {
        _map = valueMapping;

        // Build reverse map; if multiple string keys map to the same value (aliases),
        // the first key encountered becomes the canonical name for serialization.
        var reverseBuilder = ImmutableDictionary.CreateBuilder<T, string>();
        foreach (var kv in valueMapping)
        {
            if (!reverseBuilder.ContainsKey(kv.Value))
            {
                reverseBuilder.Add(kv.Value, kv.Key);
            }
        }
        _reverseMap = reverseBuilder.ToImmutable();
    }

    public override bool TryGetValue(ImmutableDictionary<string, object?> settings, out T value)
    {
        if (settings.TryGetValue(this.Name, out var objValue)
            && objValue is string strValue
            && _map.TryGetValue(strValue, out var mappedValue))
        {
            value = mappedValue;
            return true;
        }

        value = default!;
        return false;
    }

    public override ImmutableDictionary<string, object?> WithValue(ImmutableDictionary<string, object?> settings, T value)
    {
        if (_reverseMap.TryGetValue(value, out var strValue))
        {
            return settings.SetItem(this.Name, strValue);
        }
        return settings;
    }
}
