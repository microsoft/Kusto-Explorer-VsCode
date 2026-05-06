// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

namespace Kusto.Vscode;

/// <summary>
/// Provides AAD bearer tokens for Kusto cluster authentication.
/// Implementations typically delegate to the host (e.g. VS Code's
/// <c>vscode.authentication</c> API) so that sign-in UI can be shown
/// in the host process rather than in the language server process.
/// </summary>
public interface IAuthenticationProvider
{
    /// <summary>
    /// Acquires an access token for the given cluster URI.
    /// </summary>
    /// <param name="clusterUri">The cluster URI (e.g. <c>https://help.kusto.windows.net</c>).
    /// The implementation will derive the appropriate AAD scope from this.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A bearer access token, or <c>null</c> if no token could be acquired.</returns>
    Task<string?> GetAccessTokenAsync(string clusterUri, CancellationToken cancellationToken);
}
