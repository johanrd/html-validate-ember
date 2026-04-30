// Tests the two component-handling strategies:
//   1. Component name matches native HTML tag (Button, Article) → rename, children pass through
//   2. Component name doesn't match (MyButton, UserAvatar)      → blank entirely
import Component from '@glimmer/component';

export default class Demo extends Component {
  <template>
    <Article>
      <h1>Title</h1>
      <p>Body text.</p>
    </Article>

    <Button @kind="primary" type="button">Click me</Button>

    <Section>
      <h2>Subsection</h2>
    </Section>

    <MyButton @label="x">
      <span>this entire MyButton is blanked</span>
    </MyButton>

    <UserAvatar @user={{this.user}} />
  </template>
}
