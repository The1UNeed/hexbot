cask "hexbot" do
  arch arm: "arm64", intel: "x64"

  version "0.1.0"
  sha256 arm: "0000000000000000000000000000000000000000000000000000000000000000", intel: "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://hexbot.app/downloads/Hexbot-#{version}-mac-#{arch}.dmg"
  name "Hexbot"
  desc "Self-hosted multi-agent desktop app"
  homepage "https://hexbot.app"

  app "Hexbot.app"

  zap trash: "~/.hexbot"
end
