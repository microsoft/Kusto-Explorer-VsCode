// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

namespace Kusto.Vscode;

/// <summary>
/// The outcome of a host-independent language feature: a value or an error message.
/// "Nothing found" is a successful empty value, not an error.
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
    /// The value, or null when the feature failed.
    /// </summary>
    public T? Value { get; }

    /// <summary>
    /// The error message when the feature failed; otherwise null.
    /// </summary>
    public string? Error { get; }

    public bool IsError => this.Error != null;

    public static FeatureResult<T> Success(T value) => new(value, null);

    public static FeatureResult<T> Failure(string error) => new(null, error);
}
