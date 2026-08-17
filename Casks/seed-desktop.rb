cask "seed-desktop" do
  arch arm: "aarch64", intel: "x86_64"

  version "1.0.0-beta.2"
  sha256 arm:   "56d6f9391db900640969aca1f7a548368719f800c7e5598e943c25e5914bb9ac",
         intel: "6c24c38dc92c3f7bf2c62bf9dc33528aec18e840a7b517c14f0bf823d1a33612"

  url "https://github.com/reality-connect/releases/releases/download/new-seed-v#{version}/darwin-#{arch}.dmg"
  name "Seed Desktop"
  desc "Desktop app for the new-seed project"
  homepage "https://github.com/reality-connect/new-seed"

  depends_on :macos

  app "Seed Desktop.app"
end
