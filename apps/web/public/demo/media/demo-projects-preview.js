const form=document.getElementById('lead-form'), list=document.getElementById('leads'), count=document.getElementById('count');
    form.addEventListener('submit',event=>{
      event.preventDefault();
      const row=document.createElement('li');
      row.textContent=document.getElementById('name').value.trim()+' · '+document.getElementById('company').value.trim();
      list.append(row);count.textContent=list.children.length+' local entries';form.reset();
    });
