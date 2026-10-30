// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * Replaces @azure/identity in the web bundle. azure-kusto-data imports these
 * credentials for connection-string authentication modes the web build never
 * uses (it always supplies a token provider), and @azure/identity pulls in
 * Node-only dependencies. Constructing any of them fails loudly.
 */

class UnsupportedCredential {
    constructor() {
        throw new Error('This authentication method is not supported in VS Code for the Web. Sign in with a Microsoft account instead.');
    }
}

export class AzureCliCredential extends UnsupportedCredential {}
export class ManagedIdentityCredential extends UnsupportedCredential {}
export class ClientSecretCredential extends UnsupportedCredential {}
export class ClientCertificateCredential extends UnsupportedCredential {}
export class DeviceCodeCredential extends UnsupportedCredential {}
export class UsernamePasswordCredential extends UnsupportedCredential {}
export class InteractiveBrowserCredential extends UnsupportedCredential {}
