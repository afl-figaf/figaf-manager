This Markdown document provides a comprehensive reference for the SAP BTP Command Line Interface (btp CLI).

***

# SAP BTP Command Line Interface (btp CLI) Reference

This documentation is a reference for the SAP BTP Command Line Interface (btp CLI), used for account management on the SAP Business Technology Platform.

## Usage
`btp [OPTIONS] ACTION [GROUP/OBJECT] [PARAMS]`

*   **Words in caps** are placeholders.
*   **Brackets [ ]** denote optionality.
*   **OPTIONS:** `--config`, `--format`, `--help`, `--info`, `--verbose`, `--version`
*   **ACTIONS:** `list`, `get`, `create`, `update`, `delete`, `add`, `remove`, `assign`, `unassign`, `enable`, `move`, `register`, `unregister`, `subscribe`, `unsubscribe`, `share`, `unshare`
*   **GROUPS:** `accounts`, `connectivity`, `security`, `services`

---

## 1. General Commands

### `btp feedback`
Opens a web browser with a feedback survey for the btp CLI development team.
*   **Usage:** `btp [OPTIONS] feedback`

### `btp login`
Log in to a global account of SAP BTP.
*   **Usage:** `btp [OPTIONS] login [--url URL] [--subdomain GLOBALACCOUNT] [--idp ORIGIN] [--user USER] [--password PASSWORD] [--sso [SSO]] [--jwt JWT]`
*   **Tips:** Recommended to use `btp login --sso` or `btp login` without parameters.

### `btp logout`
Terminates your login and removes user-related data from local configuration.
*   **Usage:** `btp [OPTIONS] logout`

### `btp target`
Set the target for subsequent commands.
*   **Usage:** `btp [OPTIONS] target [--hierarchy [BOOL]] [--global-account [SUBDOMAIN]] [--directory ID] [--subaccount ID] [--set-favorites [BOOL]]`

### `btp enable autocomplete`
Enable command autocompletion for Bash, PowerShell (powershell or pwsh), and Zsh.
*   **Usage:** `btp [OPTIONS] enable autocomplete SHELL`

### `btp disable autocomplete`
Disable command autocompletion.
*   **Usage:** `btp [OPTIONS] disable autocomplete SHELL`

### `btp list config`
List current configuration settings.
*   **Usage:** `btp [OPTIONS] list config`

### `btp set config`
Change configuration settings.
*   **Usage:** `btp [OPTIONS] set config [--format FORMAT] [--verbose BOOL] [--login.sso MODE] [--login.securestore BOOL] [--login.showglobalaccounts BOOL] [--target.hierarchy BOOL] [--theme THEME]`

### `btp reset config`
Change configuration settings to default values.
*   **Usage:** `btp [OPTIONS] reset config [--format] [--verbose] [--login.sso] [--login.securestore] [--login.showglobalaccounts] [--target.hierarchy] [--theme] [--all]`

---

## 2. Accounts Group

### `btp list accounts/available-environment`
Show all available environments for a subaccount.
*   **Usage:** `btp [OPTIONS] list accounts/available-environment --subaccount [ID]`

### `btp get accounts/available-environment`
Show details about an available environment for a subaccount.
*   **Usage:** `btp [OPTIONS] get accounts/available-environment --subaccount [ID] --environment TYPE --service NAME --plan NAME`

### `btp list accounts/available-region`
Show all available regions for a global account.
*   **Usage:** `btp [OPTIONS] list accounts/available-region --global-account [SUBDOMAIN]`

### `btp list accounts/custom-property` (Deprecated)
Show all custom properties. Use `btp list accounts/label` instead.
*   **Usage:** `btp [OPTIONS] list accounts/custom-property [--for-directory [ID]] [--for-subaccount [ID]]`

### `btp get accounts/directory`
Show details about a directory and its contents.
*   **Usage:** `btp [OPTIONS] get accounts/directory [ID] [--show-hierarchy [BOOL]]`

### `btp create accounts/directory`
Create a directory.
*   **Usage:** `btp [OPTIONS] create accounts/directory --global-account [SUBDOMAIN] [--features LIST] --display-name NAME [--description DESCRIPTION] [--parent-directory [ID]] [--directory-admins JSON] [--subdomain SUBDOMAIN] [--labels JSON]`

### `btp update accounts/directory`
Update a directory.
*   **Usage:** `btp [OPTIONS] update accounts/directory [ID] [--display-name NAME] [--description DESCRIPTION] [--labels JSON]`

### `btp delete accounts/directory`
Delete a directory and all its data.
*   **Usage:** `btp [OPTIONS] delete accounts/directory [ID] [--force-delete [BOOL]] [--confirm [BOOL]]`

### `btp enable accounts/directory`
Change the set of enabled features for a directory.
*   **Usage:** `btp [OPTIONS] enable accounts/directory [ID] --features LIST [--directory-admins JSON] [--subdomain SUBDOMAIN] [--confirm [BOOL]]`

### `btp list accounts/entitlement`
Show all the entitlements and quota assignments.
*   **Usage:** `btp [OPTIONS] list accounts/entitlement [--directory [ID]] [--filter-by-subaccount ID] [--subaccount [ID]]`

### `btp assign accounts/entitlement`
Assign an entitlement to a subaccount or directory.
*   **Usage:** `btp [OPTIONS] assign accounts/entitlement [--to-subaccount [ID]] [--to-directory [ID]] --for-service NAME --plan NAME [--plan-unique-identifier NAME] [--enable [BOOL]] [--amount NUMBER] [--auto-distribute-amount NUMBER] [--auto-assign [BOOL]] [--distribute [BOOL]]`

### `btp list accounts/environment-instance`
Show all environment instances of a subaccount.
*   **Usage:** `btp [OPTIONS] list accounts/environment-instance --subaccount [ID]`

### `btp get accounts/environment-instance`
Show details of a specific environment instance.
*   **Usage:** `btp [OPTIONS] get accounts/environment-instance ID --subaccount [ID]`

### `btp create accounts/environment-instance`
Create an environment instance in a subaccount.
*   **Usage:** `btp [OPTIONS] create accounts/environment-instance --subaccount [ID] [--display-name NAME] [--parameters JSON] --environment TYPE [--landscape ID] --service NAME --plan NAME`

### `btp update accounts/environment-instance`
Update an environment instance of a subaccount.
*   **Usage:** `btp [OPTIONS] update accounts/environment-instance ID --subaccount [ID] --plan NAME [--parameters JSON]`

### `btp delete accounts/environment-instance`
Delete an environment instance of a subaccount.
*   **Usage:** `btp [OPTIONS] delete accounts/environment-instance ID --subaccount [ID] [--confirm [BOOL]]`

### `btp get accounts/global-account`
Show details about a global account.
*   **Usage:** `btp [OPTIONS] get accounts/global-account --global-account [SUBDOMAIN] [--show-hierarchy [BOOL]]`

### `btp update accounts/global-account`
Update a global account.
*   **Usage:** `btp [OPTIONS] update accounts/global-account --global-account [SUBDOMAIN] [--display-name NAME] [--description DESCRIPTION]`

### `btp list accounts/label`
Show all user-defined labels of a subaccount or directory.
*   **Usage:** `btp [OPTIONS] list accounts/label [--for-directory [ID]] [--for-subaccount [ID]]`

### `btp list accounts/resource-provider`
Show all resource provider instances.
*   **Usage:** `btp [OPTIONS] list accounts/resource-provider --global-account [SUBDOMAIN]`

### `btp get accounts/resource-provider`
Show details about a resource provider instance.
*   **Usage:** `btp [OPTIONS] get accounts/resource-provider --global-account [SUBDOMAIN] --provider TYPE --technical-name NAME`

### `btp create accounts/resource-provider`
Create a resource provider instance.
*   **Usage:** `btp [OPTIONS] create accounts/resource-provider --global-account [SUBDOMAIN] --provider TYPE --technical-name NAME --display-name NAME [--description DESCRIPTION] --configuration-info JSON`

### `btp update accounts/resource-provider`
Update a resource provider instance.
*   **Usage:** `btp [OPTIONS] update accounts/resource-provider --global-account [SUBDOMAIN] --provider TYPE --technical-name NAME --display-name NAME [--description DESCRIPTION] [--configuration-info JSON]`

### `btp delete accounts/resource-provider`
Delete a resource provider instance.
*   **Usage:** `btp [OPTIONS] delete accounts/resource-provider --global-account [SUBDOMAIN] --provider TYPE --technical-name NAME [--confirm [BOOL]]`

### `btp list accounts/subaccount`
Show all subaccounts in a global account.
*   **Usage:** `btp [OPTIONS] list accounts/subaccount --global-account [SUBDOMAIN] [--labels-filter QUERY] [--authorized [BOOL]]`

### `btp get accounts/subaccount`
Show details about a subaccount.
*   **Usage:** `btp [OPTIONS] get accounts/subaccount [ID]`

### `btp create accounts/subaccount`
Create a subaccount in a global account or directory.
*   **Usage:** `btp [OPTIONS] create accounts/subaccount --global-account [SUBDOMAIN] --display-name NAME --region REGION [--subdomain SUBDOMAIN] [--used-for-production BOOL] [--description DESCRIPTION] [--directory [ID]] [--beta-enabled [BOOL]] [--subaccount-admins JSON] [--labels JSON] [--disable-wait-for-auto-assign-plans [BOOL]] [--skip-auto-assign-plans [BOOL]]`

### `btp update accounts/subaccount`
Update a subaccount.
*   **Usage:** `btp [OPTIONS] update accounts/subaccount [ID] [--display-name NAME] [--used-for-production [BOOL]] [--description DESCRIPTION] [--beta-enabled [BOOL]] [--labels JSON] [--add-me-as-admin [BOOL]]`

### `btp delete accounts/subaccount`
Delete a subaccount and all its data.
*   **Usage:** `btp [OPTIONS] delete accounts/subaccount [ID] [--force-delete [BOOL]] [--confirm [BOOL]]`

### `btp restore accounts/subaccount`
Restore a subaccount that is pending deletion.
*   **Usage:** `btp [OPTIONS] restore accounts/subaccount [ID]`

### `btp move accounts/subaccount`
Move a subaccount.
*   **Usage:** `btp [OPTIONS] move accounts/subaccount [ID] [--to-directory ID] [--to-global-account [BOOL]]`

### `btp subscribe accounts/subaccount`
Subscribe to an application from a subaccount.
*   **Usage:** `btp [OPTIONS] subscribe accounts/subaccount --subaccount [ID] --to-app NAME [--plan NAME] [--parameters JSON]`

### `btp unsubscribe accounts/subaccount`
Unsubscribe an application from a subaccount.
*   **Usage:** `btp [OPTIONS] unsubscribe accounts/subaccount --subaccount [ID] --from-app NAME [--confirm [BOOL]]`

---

## 3. Connectivity Group

### `btp list connectivity/destination-certificate`
(Experimental) List certificates on the specified subaccount or service instance level.
*   **Usage:** `btp [OPTIONS] list connectivity/destination-certificate --subaccount [ID] [--service-instance ID] [--names-only [BOOL]]`

### `btp get connectivity/destination-certificate`
(Experimental) Retrieve a certificate in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] get connectivity/destination-certificate --name NAME --subaccount [ID] [--service-instance ID]`

### `btp create connectivity/destination-certificate`
(Experimental) Create a certificate in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] create connectivity/destination-certificate --file CERTIFICATE --subaccount [ID] [--service-instance ID]`

### `btp delete connectivity/destination-certificate`
(Experimental) Delete a certificate in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] delete connectivity/destination-certificate --name NAME --subaccount [ID] [--service-instance ID]`

### `btp list connectivity/destination-fragment`
(Experimental) List fragments on the specified subaccount or service instance level.
*   **Usage:** `btp [OPTIONS] list connectivity/destination-fragment --subaccount [ID] [--service-instance ID]`

### `btp get connectivity/destination-fragment`
(Experimental) Retrieve a fragment in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] get connectivity/destination-fragment --name NAME --subaccount [ID] [--service-instance ID]`

### `btp create connectivity/destination-fragment`
(Experimental) Create a fragment in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] create connectivity/destination-fragment --configuration JSON --subaccount [ID] [--service-instance ID]`

### `btp update connectivity/destination-fragment`
(Experimental) Update a fragment in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] update connectivity/destination-fragment --configuration JSON --subaccount [ID] [--service-instance ID]`

### `btp delete connectivity/destination-fragment`
(Experimental) Delete a fragment in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] delete connectivity/destination-fragment --name NAME --subaccount [ID] [--service-instance ID]`

### `btp get connectivity/destination-trust`
(Experimental) Retrieve a trust certificate within a subaccount.
*   **Usage:** `btp [OPTIONS] get connectivity/destination-trust [--active [BOOL]] [--passive [BOOL]] --subaccount [ID]`

### `btp create connectivity/destination-trust`
(Experimental) Create a trust certificate within a subaccount.
*   **Usage:** `btp [OPTIONS] create connectivity/destination-trust [--active [BOOL]] [--passive [BOOL]] --subaccount [ID]`

### `btp delete connectivity/destination-trust`
(Experimental) Delete the passive trust certificate within a subaccount.
*   **Usage:** `btp [OPTIONS] delete connectivity/destination-trust [--passive [BOOL]] --subaccount [ID]`

### `btp rotate connectivity/destination-trust`
(Experimental) Rotate the trust certificates within a subaccount.
*   **Usage:** `btp [OPTIONS] rotate connectivity/destination-trust --subaccount [ID]`

### `btp list connectivity/destination`
(Experimental) List destinations on the specified subaccount or service instance level.
*   **Usage:** `btp [OPTIONS] list connectivity/destination --subaccount [ID] [--service-instance ID] [--names-only [BOOL]]`

### `btp get connectivity/destination`
(Experimental) Retrieve a destination in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] get connectivity/destination --name NAME --subaccount [ID] [--service-instance ID]`

### `btp create connectivity/destination`
(Experimental) Create a destination in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] create connectivity/destination --configuration JSON --subaccount [ID] [--service-instance ID]`

### `btp update connectivity/destination`
(Experimental) Update a destination in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] update connectivity/destination --configuration JSON --subaccount [ID] [--service-instance ID]`

### `btp delete connectivity/destination`
(Experimental) Delete a destination in a subaccount or specific service instance.
*   **Usage:** `btp [OPTIONS] delete connectivity/destination --name NAME --subaccount [ID] [--service-instance ID]`

---

## 4. Security Group

### `btp list security/api-credential`
Show all security API credentials for API access.
*   **Usage:** `btp [OPTIONS] list security/api-credential [--global-account [SUBDOMAIN]] [--subaccount [SUBDOMAIN]] [--directory [SUBDOMAIN]]`

### `btp get security/api-credential`
Show details of a specific credential for API access.
*   **Usage:** `btp [OPTIONS] get security/api-credential NAME [--global-account [SUBDOMAIN]] [--subaccount [SUBDOMAIN]] [--directory [SUBDOMAIN]]`

### `btp create security/api-credential`
Create a credential for API access.
*   **Usage:** `btp [OPTIONS] create security/api-credential [--name NAME] [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--directory [ID]] [--certificate CERT] [--read-only BOOL]`

### `btp delete security/api-credential`
Delete a credential for API access.
*   **Usage:** `btp [OPTIONS] delete security/api-credential NAME [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--directory [ID]] [--confirm [BOOL]]`

### `btp list security/app`
Show all apps.
*   **Usage:** `btp [OPTIONS] list security/app [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp get security/app`
Show details about a specific app.
*   **Usage:** `btp [OPTIONS] get security/app ID [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp list security/available-idp`
Show all available SAP Cloud Identity Services tenants.
*   **Usage:** `btp [OPTIONS] list security/available-idp [--global-account [SUBDOMAIN]] [--subaccount [ID]]`

### `btp get security/available-idp`
Show details about an available SAP Cloud Identity Services tenant.
*   **Usage:** `btp [OPTIONS] get security/available-idp TENANT [--global-account [SUBDOMAIN]] [--subaccount [ID]]`

### `btp list security/role-collection`
Show all role collections.
*   **Usage:** `btp [OPTIONS] list security/role-collection [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp get security/role-collection`
Show details about a role collection.
*   **Usage:** `btp [OPTIONS] get security/role-collection NAME [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]] [--show-attribute-mappings [BOOL]]`

### `btp create security/role-collection`
Create a role collection.
*   **Usage:** `btp [OPTIONS] create security/role-collection NAME [--description DESCRIPTION] [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp update security/role-collection`
Update the description of a role collection.
*   **Usage:** `btp [OPTIONS] update security/role-collection NAME --description DESCRIPTION [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp delete security/role-collection`
Delete a role collection.
*   **Usage:** `btp [OPTIONS] delete security/role-collection NAME [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp assign security/role-collection`
Assign a role collection to a user, user group, or user attribute.
*   **Usage:** `btp [OPTIONS] assign security/role-collection NAME [--to-user EMAIL] [--create-user-if-missing [BOOL]] [--of-idp ORIGIN] [--to-group GROUP] [--to-attribute ATTRIBUTE] [--attribute-value ATTRIBUTEVALUE] [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp unassign security/role-collection`
Unassign a role collection from a user, user group, or user attribute.
*   **Usage:** `btp [OPTIONS] unassign security/role-collection NAME [--from-user EMAIL] [--of-idp ORIGIN] [--from-group GROUP] [--from-attribute ATTRIBUTE] [--attribute-value ATTRIBUTEVALUE] [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp list security/role`
Show all roles.
*   **Usage:** `btp [OPTIONS] list security/role [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp get security/role`
Show details about a specific role.
*   **Usage:** `btp [OPTIONS] get security/role NAME --of-app ID --of-role-template NAME [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp create security/role`
Create a role.
*   **Usage:** `btp [OPTIONS] create security/role NAME --of-app ID --of-role-template NAME [--description DESCRIPTION] [--attributes JSON] [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp delete security/role`
Delete a role.
*   **Usage:** `btp [OPTIONS] delete security/role NAME --of-app ID --of-role-template NAME [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp add security/role`
Add a role to a role collection.
*   **Usage:** `btp [OPTIONS] add security/role NAME --to-role-collection NAME --of-app ID --of-role-template NAME [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp remove security/role`
Remove a role from a role collection.
*   **Usage:** `btp [OPTIONS] remove security/role NAME --from-role-collection NAME --of-app ID --of-role-template NAME [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp list security/settings`
Show the security settings of a global account or subaccount.
*   **Usage:** `btp [OPTIONS] list security/settings [--global-account [SUBDOMAIN]] [--subaccount [ID]]`

### `btp update security/settings`
Update security settings of a global account or subaccount.
*   **Usage:** `btp [OPTIONS] update security/settings [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--iframe DOMAIN] [--custom-email JSON] [--default-idp-for-noninteractive-logon ORIGIN] [--treat-users-with-same-email-as-same-user BOOL] [--use-idp-user-name-in-tokens BOOL] [--home-redirect URL] [--access-token-validity DURATION] [--refresh-token-validity DURATION] [--rotate-signing-key-automatically BOOL]`

### `btp list security/token-key`
Show all signing keys for access tokens.
*   **Usage:** `btp [OPTIONS] list security/token-key [--global-account [SUBDOMAIN]] [--subaccount [ID]]`

### `btp create security/token-key`
Create a new signing key for access tokens.
*   **Usage:** `btp [OPTIONS] create security/token-key [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--key ID]`

### `btp delete security/token-key`
Delete a disabled signing key for access tokens.
*   **Usage:** `btp [OPTIONS] delete security/token-key --key ID [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--confirm [BOOL]] [--force [BOOL]]`

### `btp enable security/token-key`
Enable an existing key as signing key for access tokens.
*   **Usage:** `btp [OPTIONS] enable security/token-key --key ID [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--force [BOOL]]`

### `btp rotate security/token-key`
Rotate the key without waiting for the next regular rotation.
*   **Usage:** `btp [OPTIONS] rotate security/token-key [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--confirm [BOOL]]`

### `btp list security/trust`
Show all trust configurations.
*   **Usage:** `btp [OPTIONS] list security/trust [--global-account [SUBDOMAIN]] [--subaccount [ID]]`

### `btp get security/trust`
Show details about a trust configuration.
*   **Usage:** `btp [OPTIONS] get security/trust ORIGIN [--global-account [SUBDOMAIN]] [--subaccount [ID]]`

### `btp create security/trust`
Establish trust to an SAP Cloud Identity Services tenant.
*   **Usage:** `btp [OPTIONS] create security/trust --idp TENANT [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--domain DOMAIN] [--name NAME] [--origin ORIGIN] [--description DESCRIPTION]`

### `btp update security/trust`
Update a trust configuration.
*   **Usage:** `btp [OPTIONS] update security/trust ORIGIN [--global-account [SUBDOMAIN]] [--subaccount [ID]] [--domain DOMAIN] [--idp TENANT] [--name NAME] [--status STATUS] [--link-text TEXT] [--description DESCRIPTION] [--available-for-user-logon [BOOL]] [--auto-create-shadow-users [BOOL]] [--refresh [BOOL]]`

### `btp delete security/trust`
Delete a trust configuration.
*   **Usage:** `btp [OPTIONS] delete security/trust ORIGIN [--subaccount [ID]] [--global-account [SUBDOMAIN]] [--confirm [BOOL]]`

### `btp migrate security/trust`
Migrate from SAML Trust to OpenID Connect Trust.
*   **Usage:** `btp [OPTIONS] migrate security/trust ORIGIN --idp TENANT --subaccount [ID] [--domain DOMAIN]`

### `btp restore security/trust`
Undo migration from SAML Trust to OpenID Connect Trust.
*   **Usage:** `btp [OPTIONS] restore security/trust ORIGIN --subaccount [ID]`

### `btp list security/user`
Show all users.
*   **Usage:** `btp [OPTIONS] list security/user [--of-idp ORIGIN] [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp get security/user`
Show details about a specific user.
*   **Usage:** `btp [OPTIONS] get security/user EMAIL [--of-idp ORIGIN] [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

### `btp delete security/user`
Delete a user.
*   **Usage:** `btp [OPTIONS] delete security/user EMAIL [--of-idp ORIGIN] [--global-account [SUBDOMAIN]] [--directory [ID]] [--subaccount [ID]]`

---

## 5. Services Group

### `btp list services/binding`
Show all service bindings.
*   **Usage:** `btp [OPTIONS] list services/binding --subaccount [ID] [--labels-filter QUERY] [--fields-filter QUERY]`

### `btp get services/binding`
Show details about a service binding.
*   **Usage:** `btp [OPTIONS] get services/binding [ID] [--id ID] [--name NAME] --subaccount [ID] [--show-parameters [BOOL]]`

### `btp create services/binding`
Create a service binding.
*   **Usage:** `btp [OPTIONS] create services/binding --subaccount [ID] --binding NAME [--instance-name NAME] [--service-instance ID] [--parameters JSON] [--labels JSON] [--force [BOOL]]`

### `btp delete services/binding`
Delete a service binding.
*   **Usage:** `btp [OPTIONS] delete services/binding [ID] [--id ID] [--name NAME] --subaccount [ID] [--confirm [BOOL]] [--force [BOOL]]`

### `btp list services/broker`
Show all service brokers.
*   **Usage:** `btp [OPTIONS] list services/broker --subaccount [ID] [--labels-filter QUERY] [--fields-filter QUERY]`

### `btp get services/broker`
Show details about a service broker.
*   **Usage:** `btp [OPTIONS] get services/broker [ID] [--id ID] [--name NAME] --subaccount [ID]`

### `btp update services/broker`
Update a service broker.
*   **Usage:** `btp [OPTIONS] update services/broker [ID] [--id ID] [--name NAME] [--new-name NAME] [--url URL] [--user USER] [--password PASSWORD] [--use-sm-tls [BOOL]] [--cert FILE] [--key FILE] [--description DESCRIPTION] --subaccount [ID] [--labels JSON]`

### `btp register services/broker`
Register a service broker.
*   **Usage:** `btp [OPTIONS] register services/broker --name NAME --url URL [--user USER] [--password PASSWORD] [--use-sm-tls [BOOL]] [--cert FILE] [--key FILE] [--description DESCRIPTION] --subaccount [ID] [--labels JSON]`

### `btp unregister services/broker`
Unregister a service broker.
*   **Usage:** `btp [OPTIONS] unregister services/broker [ID] [--id ID] [--name NAME] --subaccount [ID] [--confirm [BOOL]]`

### `btp list services/instance`
Show all service instances.
*   **Usage:** `btp [OPTIONS] list services/instance --subaccount [ID] [--labels-filter QUERY] [--fields-filter QUERY]`

### `btp get services/instance`
Show details about a service instance.
*   **Usage:** `btp [OPTIONS] get services/instance [ID] [--id ID] [--name NAME] --subaccount [ID] [--show-parameters [BOOL]]`

### `btp create services/instance`
Create a service instance.
*   **Usage:** `btp [OPTIONS] create services/instance --subaccount [ID] [--data-center NAME] --service NAME [--plan ID] [--plan-name NAME] [--offering-name NAME] [--parameters JSON] [--labels JSON]`

### `btp update services/instance`
Update a service instance.
*   **Usage:** `btp [OPTIONS] update services/instance [ID] [--id ID] --subaccount [ID] [--name NAME] [--new-name NAME] [--plan ID] [--plan-name NAME] [--parameters JSON] [--labels JSON]`

### `btp delete services/instance`
Delete a service instance.
*   **Usage:** `btp [OPTIONS] delete services/instance [ID] [--id ID] [--name NAME] --subaccount [ID] [--confirm [BOOL]]`

### `btp share services/instance`
Share a service instance.
*   **Usage:** `btp [OPTIONS] share services/instance [ID] [--id ID] --subaccount [ID] [--name NAME]`

### `btp unshare services/instance`
Unshare a service instance.
*   **Usage:** `btp [OPTIONS] unshare services/instance [ID] [--id ID] --subaccount [ID] [--name NAME]`

### `btp list services/offering`
Show all service offerings.
*   **Usage:** `btp [OPTIONS] list services/offering --subaccount [ID] [--environment TYPE] [--labels-filter QUERY] [--fields-filter QUERY] [--show-data-center [BOOL]]`

### `btp get services/offering`
Show details about a service offering.
*   **Usage:** `btp [OPTIONS] get services/offering [ID] [--id ID] [--name NAME] [--data-center NAME] --subaccount [ID]`

### `btp list services/plan`
Show all service plans.
*   **Usage:** `btp [OPTIONS] list services/plan --subaccount [ID] [--environment TYPE] [--labels-filter QUERY] [--fields-filter QUERY] [--show-data-center [BOOL]]`

### `btp get services/plan`
Show details about a service plan.
*   **Usage:** `btp [OPTIONS] get services/plan [ID] [--id ID] [--name NAME] [--offering-name NAME] [--data-center NAME] --subaccount [ID]`

### `btp list services/platform`
Show all platforms.
*   **Usage:** `btp [OPTIONS] list services/platform --subaccount [ID] [--labels-filter QUERY] [--fields-filter QUERY]`

### `btp get services/platform`
Show details about a platform.
*   **Usage:** `btp [OPTIONS] get services/platform [ID] [--id ID] [--name NAME] --subaccount [ID]`

### `btp update services/platform`
Update a platform.
*   **Usage:** `btp [OPTIONS] update services/platform ID [--name NAME] [--regenerate-credentials [BOOL]] [--description DESCRIPTION] --subaccount [ID] [--labels JSON]`

### `btp register services/platform`
Register a platform.
*   **Usage:** `btp [OPTIONS] register services/platform --name NAME [--id ID] [--type TYPE] [--description DESCRIPTION] --subaccount [ID] [--labels JSON]`

### `btp unregister services/platform`
Unregister a platform.
*   **Usage:** `btp [OPTIONS] unregister services/platform [ID] [--id ID] [--name NAME] [--cascade [BOOL]] --subaccount [ID] [--confirm [BOOL]]`

---

## 6. Disaster Recovery Group

### `btp get disaster-recovery/subaccount-pair`
Show details about a subaccount pair.
*   **Usage:** `btp [OPTIONS] get disaster-recovery/subaccount-pair --subaccount ID`

### `btp create disaster-recovery/subaccount-pair`
Pair a subaccount with another subaccount.
*   **Usage:** `btp [OPTIONS] create disaster-recovery/subaccount-pair --subaccount ID --with-subaccount ID`

### `btp delete disaster-recovery/subaccount-pair`
Unpair a subaccount with its paired subaccount.
*   **Usage:** `btp [OPTIONS] delete disaster-recovery/subaccount-pair --subaccount ID`