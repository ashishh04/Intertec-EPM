# EPM: enable the OAuth2 Resource Owner Password Credentials grant.
#
# EPM is a first-party wrapper around this OpenProject instance: users sign in
# on EPM's own form and never see OpenProject. That requires exchanging a
# username and password for a token directly, which OpenProject does not permit
# out of the box — API v3 dropped per-user Basic auth, and Doorkeeper ships with
# the password flow disabled and `resource_owner_from_credentials` unconfigured.
#
# This file enables that flow and points it at OpenProject's own authentication,
# so password policy, LDAP, brute-force blocking and account status are all
# still enforced by OpenProject. Nothing here validates a password itself.
#
# Scope of the change:
#   * adds "password" to Doorkeeper's grant flows
#   * implements resource_owner_from_credentials via User.try_to_login
#
# It deliberately does NOT touch token lifetimes, scopes, or any other
# Doorkeeper setting, and it mutates the existing configuration rather than
# re-declaring it, so every other OpenProject default is preserved.
#
# Runs last (zzz_ prefix) so Doorkeeper is fully configured before it applies.

Rails.application.config.after_initialize do
  config = Doorkeeper.config

  flows = config.grant_flows
  unless flows.include?("password")
    config.instance_variable_set(:@grant_flows, flows + ["password"])

    # Doorkeeper memoises the grant/response types it derives from grant_flows,
    # so the cached values have to be dropped or the new flow is advertised but
    # not actually accepted at /oauth/token.
    %i[@token_grant_types @authorization_response_types].each do |ivar|
      config.remove_instance_variable(ivar) if config.instance_variable_defined?(ivar)
    end
  end

  # Evaluated in the token controller, so `params` is the request's parameters.
  # Returning nil makes Doorkeeper answer with invalid_grant, which is what an
  # unknown user, a wrong password, or a locked account should all look like.
  credentials_handler = proc do |_routes|
    login = params[:username].to_s
    password = params[:password].to_s
    next nil if login.empty? || password.empty?

    User.try_to_login(login, password)
  end

  config.instance_variable_set(:@resource_owner_from_credentials, credentials_handler)
end
