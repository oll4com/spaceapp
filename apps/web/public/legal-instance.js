// The privacy and terms pages name the instance's own host and contact, so every installation describes itself.
// A file, not an inline script: the app pages' script policy allows only scripts from this origin (security addendum step 7).
document.querySelectorAll("[data-instance-host]").forEach(function (node) { node.textContent = location.hostname; });
var email = window.__SPACE_PUBLIC_CONFIG__ && window.__SPACE_PUBLIC_CONFIG__.contactEmail;
if (email) document.querySelectorAll("[data-contact]").forEach(function (node) {
  var link = document.createElement("a"); link.href = "mailto:" + email; link.textContent = email; node.replaceChildren(link);
});
