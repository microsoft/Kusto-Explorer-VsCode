// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

namespace Kusto.Vscode;

/// <summary>
/// The outcome of a host-independent language feature: a value, nothing (the feature has nothing
/// to offer at that position), or an error message.
/// Cancellation is not an error; it surfaces as <see cref="OperationCanceledException"/>.
/// </summary>
public sealed class FeatureResult<T> where T : class
{
    private FeatureResult(T? value, string? error)
    {
        this.Value = value;
        this.Error = error;
    }

    /// <summary>
    /// The value, or null when the feature produced nothing or failed.
    /// </summary>
    public T? Value { get; }

    /// <summary>
    /// The error message when the feature failed; otherwise null.
    /// </summary>
    public string? Error { get; }

    public bool IsError => this.Error != null;

    public static FeatureResult<T> Success(T value) => new(value, null);

    public static FeatureResult<T> Failure(string error) => new(null, error);

    public static readonly FeatureResult<T> None = new(null, null);
}
