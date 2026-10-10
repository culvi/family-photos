from app.static_versioning import asset_version, versioned_html


def _site(tmp_path, app_js="console.log(1);"):
    (tmp_path / "js").mkdir()
    (tmp_path / "css").mkdir()
    (tmp_path / "js" / "app.js").write_text(app_js)
    (tmp_path / "css" / "styles.css").write_text("body{}")
    page = tmp_path / "index.html"
    page.write_text(
        '<link rel="stylesheet" href="css/styles.css">\n'
        '<script src="js/app.js"></script>\n'
        '<img src="immich-logo.svg">\n'
        '<a href="https://example.com/x.js">x</a>\n'
    )
    return page


def test_local_js_and_css_links_get_the_content_version(tmp_path):
    page = _site(tmp_path)
    version = asset_version(tmp_path)
    html = versioned_html(page)

    assert f'href="css/styles.css?v={version}"' in html
    assert f'src="js/app.js?v={version}"' in html
    assert 'src="immich-logo.svg"' in html
    assert 'href="https://example.com/x.js"' in html
    assert len(version) == 12


def test_version_changes_when_any_frontend_file_changes(tmp_path):
    one = tmp_path / "one"
    two = tmp_path / "two"
    one.mkdir()
    two.mkdir()
    _site(one, app_js="console.log(1);")
    _site(two, app_js="console.log(2);")

    assert asset_version(one) != asset_version(two)
