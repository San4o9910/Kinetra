#!/usr/bin/env python3
"""Read-only launch gate with approved CPE and public-package scope.

No host/provider operations. Unrelated original assertions are retained.
GitHub readers also authenticate the prior database handoff.
"""


def verify_approved_public_package(package, target, app):
    """Existing project packages, explicitly authorized coaching release on September 15."""
    assert app == 'a61a42f2dc10749939a1044990bf2cf456e34b52'
    approved_ids = {'backend': 15042113, 'frontend': 15042114}
    assert target in approved_ids and isinstance(package, dict)
    assert type(package.get('id')) is int and package['id'] == approved_ids[target]
    assert package.get('name') == 'kinetra-' + target
    assert package.get('package_type') == 'container' and package.get('visibility') == 'public'
    assert isinstance(package.get('owner'), dict) and package['owner'].get('login') == 'San4o9910'
    repository = package.get('repository')
    assert isinstance(repository, dict) and repository.get('full_name') == 'San4o9910/Kinetra'
    assert type(repository.get('id')) is int and repository['id'] == 1339664626

